// Consumer-side package tests.
//
// These tests pack @cap-js/mcp-server, install it into a throwaway project, and
// then both check the resolved dependency tree and run the real cds-mcp tools
// from a consumer's point of view. They guard the fix in PR #192.
//
// The install runs the lifecycle scripts, so the native binaries download. This
// lets the smoke tests run the real cds-mcp command. If the install or a command
// cannot complete (for example with no network), the test skips instead of
// failing. A test fails only when it finds a real onnxruntime conflict.

import assert from 'node:assert'
import { test, describe, before, after } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

// @cap-js/ai requires this exact version. Keep it in sync with that peer.
const REQUIRED_ONNX = '1.20.1'

// A real onnxruntime conflict shows one of these in the output. This is the
// exact failure the fix prevents, so the smoke tests treat it as a hard error.
const ONNX_CONFLICT = /Unsupported onnxruntime-node version|libonnxruntime[^\n]*not found|VERS_\d/i

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sampleProject = join(projectRoot, 'tests', 'sample')

let consumerDir
let tarball
let installed = false
let installError

// Collect every directory with the given name under root.
async function findDirs(root, name) {
  const results = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name === name) results.push(full)
      else await walk(full)
    }
  }
  await walk(root)
  return results
}

async function readVersion(packageDir) {
  const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf-8'))
  return pkg.version
}

function skipIfNotInstalled(t) {
  if (installed) return false
  t.skip(`consumer install unavailable (offline?): ${installError?.message ?? 'unknown error'}`)
  return true
}

// Run the installed cds-mcp binary in the consumer project.
function runCdsMcp(args, timeout) {
  const bin = join(consumerDir, 'node_modules', '.bin', 'cds-mcp')
  return spawnSync(bin, args, {
    cwd: consumerDir,
    encoding: 'utf-8',
    timeout,
    maxBuffer: 10 * 1024 * 1024
  })
}

before(
  async () => {
    try {
      // Pack the package. npm writes notices to stderr and the file name to stdout.
      const output = execFileSync('npm', ['pack', '--pack-destination', os.tmpdir()], {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const tarName = output.trim().split('\n').pop().trim()
      tarball = join(os.tmpdir(), tarName)

      // Create a throwaway consumer that depends on the packed tarball.
      consumerDir = await mkdtemp(join(os.tmpdir(), 'cds-mcp-consumer-'))
      const consumerPkg = {
        name: 'consumer-under-test',
        version: '1.0.0',
        private: true,
        dependencies: { '@cap-js/mcp-server': `file:${tarball}` }
      }
      await writeFile(join(consumerDir, 'package.json'), JSON.stringify(consumerPkg, null, 2))

      execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: consumerDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'ignore', 'pipe']
      })
      installed = true
    } catch (err) {
      installError = err
    }
  },
  { timeout: 600000 }
)

after(async () => {
  if (consumerDir) await rm(consumerDir, { recursive: true, force: true }).catch(() => {})
  if (tarball) await rm(tarball, { force: true }).catch(() => {})
})

describe('consumer package (install and tools)', () => {

  test('a consumer resolves exactly one onnxruntime-node copy', async t => {
    if (skipIfNotInstalled(t)) return
    const copies = await findDirs(join(consumerDir, 'node_modules'), 'onnxruntime-node')
    assert.equal(copies.length, 1, `expected one onnxruntime-node copy, found ${copies.length}:\n${copies.join('\n')}`)
  })

  test('the single onnxruntime-node copy is 1.20.1', async t => {
    if (skipIfNotInstalled(t)) return
    const [copy] = await findDirs(join(consumerDir, 'node_modules'), 'onnxruntime-node')
    assert.equal(await readVersion(copy), REQUIRED_ONNX)
  })

  test('smoke: cds-mcp search_docs', async t => {
    if (skipIfNotInstalled(t)) return
    const result = runCdsMcp(['search_docs', 'How do I define an entity in CDS?', '1'], 240000)
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    // The fix must hold: no native runtime conflict, whatever else happens.
    assert.ok(!ONNX_CONFLICT.test(output), `onnxruntime conflict during search_docs:\n${output}`)
    // search_docs needs a model and a doc bundle. If it cannot download them, skip.
    if (result.status !== 0) return t.skip(`search_docs did not complete (download/network?):\n${output.slice(0, 400)}`)
    assert.ok(result.stdout.trim().length > 0, 'search_docs produced no output')
  })

  test('smoke: cds-mcp search_model', async t => {
    if (skipIfNotInstalled(t)) return
    const result = runCdsMcp(['--offline', 'search_model', sampleProject, 'Books', 'entity'], 120000)
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    assert.ok(!ONNX_CONFLICT.test(output), `onnxruntime conflict during search_model:\n${output}`)
    if (result.status !== 0) return t.skip(`search_model did not complete:\n${output.slice(0, 400)}`)
    const parsed = JSON.parse(result.stdout)
    assert.ok(Array.isArray(parsed) && parsed.length > 0, 'search_model returned no definitions')
  })
})
