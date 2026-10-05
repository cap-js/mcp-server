// CLI test for cds-mcp command-line usage
import assert from 'node:assert'
import { test, describe, before, after } from 'node:test'
import { spawn } from 'node:child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import os from 'os'
import { DEFAULT_DIR } from '../lib/calculateEmbeddings.js'
import { seedCliTestBundle } from './helpers/test-bundle.js'
import { TEST_COMMIT_ID } from './helpers/paths.js'

const sampleProjectPath = join(dirname(fileURLToPath(import.meta.url)), 'sample')
const cdsMcpPath = join(dirname(fileURLToPath(import.meta.url)), '../index.js')

// Subprocess fetch mock — injected via NODE_OPTIONS=--import into child processes.
// Reads a prebuilt bundle from CDS_MCP_TEST_BUNDLE_PATH and serves it for /getEmbeddings.
const bundleMockScript = `
import { readFileSync } from 'node:fs'
import { mock } from 'node:test'
const prebuilt = readFileSync(process.env.CDS_MCP_TEST_BUNDLE_PATH)
const commitId = process.env.CDS_MCP_TEST_BUNDLE_VERSION ?? '__test_bundle__'
mock.method(globalThis, 'fetch', async () =>
  new Response(prebuilt, {
    status: 200,
    headers: { etag: \`W/"\${commitId}"\`, 'x-embeddings-version': commitId, 'content-type': 'application/octet-stream' }
  })
)
`
const mockFetchUrl = `data:text/javascript,${encodeURIComponent(bundleMockScript)}`

let ctx

function runCliCommand(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [cdsMcpPath, ...args], {
      ...options,
      stdio: 'pipe'
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', data => {
      stdout += data.toString()
    })

    child.stderr.on('data', data => {
      stderr += data.toString()
    })

    child.on('close', code => {
      resolve({ code, stdout, stderr })
    })

    child.on('error', error => {
      reject(error)
    })
  })
}

const noFetchEnv = {
  ...process.env,
  NODE_OPTIONS:
    '--import "data:text/javascript,globalThis.fetch = () => { throw new Error(\'fetch disabled in offline mode\') }"'
}

before(async () => {
  ctx = await seedCliTestBundle()
})

after(() => ctx.cleanup())

describe('CLI usage', () => {
  test('search_model returns matching definitions for a project path', async () => {
    const result = await runCliCommand(['search_model', sampleProjectPath, 'Books', 'entity'])

    assert.equal(result.code, 0, 'Command should exit with code 0')
    assert(result.stdout.length > 0, 'Should produce output')

    const output = JSON.parse(result.stdout)
    assert(Array.isArray(output), 'Output should be an array')
    assert(output.length > 0, 'Should find at least one result')
    assert(output[0].name, 'Result should have a name property')
  })

  test('search_model accepts an explicit project path outside the CLI working directory', async () => {
    const result = await runCliCommand(['--offline', 'search_model', sampleProjectPath, 'Books', 'entity'], {
      cwd: os.tmpdir()
    })

    assert.equal(result.code, 0, 'Command should exit with code 0')
    assert.equal(JSON.parse(result.stdout)[0].name, 'AdminService.Books')
  })

  test('search_model accepts sibling model imports for an explicitly trusted CLI project', async t => {
    const monorepo = await fs.mkdtemp(join(os.tmpdir(), 'cds-mcp-cli-monorepo-'))
    const cwd = await fs.mkdtemp(join(os.tmpdir(), 'cds-mcp-cli-cwd-'))
    t.after(() =>
      Promise.all([fs.rm(monorepo, { recursive: true, force: true }), fs.rm(cwd, { recursive: true, force: true })])
    )
    const project = join(monorepo, 'app')
    await Promise.all([fs.mkdir(join(project, 'srv'), { recursive: true }), fs.mkdir(join(monorepo, 'shared'))])
    await fs.writeFile(join(monorepo, 'shared', 'model.cds'), 'entity SharedBooks { key ID: Integer; }')
    await fs.writeFile(
      join(project, 'srv', 'service.cds'),
      "using { SharedBooks } from '../../shared/model'; service MonorepoService { entity Books as projection on SharedBooks; }"
    )

    const result = await runCliCommand(['--offline', 'search_model', project, 'SharedBooks', 'entity'], { cwd })

    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout)[0].name, 'SharedBooks')
  })

  test('search_docs returns document chunks separated by --- for a query', async () => {
    const result = await runCliCommand(['search_docs', 'select statement'], {
      env: {
        ...process.env,
        CDS_MCP_TEST_BUNDLE_PATH: ctx.bundlePath,
        CDS_MCP_TEST_BUNDLE_VERSION: TEST_COMMIT_ID,
        NODE_OPTIONS: `--import "${mockFetchUrl}"`
      }
    })

    assert.equal(result.code, 0, 'Command should exit with code 0')
    assert(result.stdout.length > 0, 'Should produce output')
    assert(typeof result.stdout === 'string', 'Output should be a string')
    assert(result.stdout.includes('---'), 'Output should contain document separators')
  })

  test('search_docs produces no output on stderr', async () => {
    const result = await runCliCommand(['search_docs', 'select statement'], {
      env: {
        ...process.env,
        CDS_MCP_TEST_BUNDLE_PATH: ctx.bundlePath,
        CDS_MCP_TEST_BUNDLE_VERSION: TEST_COMMIT_ID,
        NODE_OPTIONS: `--import "${mockFetchUrl}"`
      }
    })

    assert.equal(result.code, 0, 'Command should exit with code 0')
    assert.equal(result.stderr, '', `Expected no stderr output, got: ${result.stderr}`)
    const lines = result.stdout.split('\n')
    assert.equal(lines[0].includes('headingPath:'), true, 'stdout should start with output and nothing else')
  })

  test('invalid tool name shows error', async () => {
    const result = await runCliCommand(['invalid_tool', 'arg1'])

    assert.equal(result.code, 1, 'Command should exit with code 1')
    assert(result.stderr.includes("Tool 'invalid_tool' not found"), 'Should show tool not found error')
    assert(result.stderr.includes('Available tools:'), 'Should list available tools')
  })

  test('--help shows usage information', async () => {
    const result = await runCliCommand(['--help'])

    assert.equal(result.code, 0, 'Command should exit with code 0')
    assert(result.stdout.includes('Usage: cds-mcp'), 'Should show usage line')
    assert(result.stdout.includes('--help'), 'Should list --help option')
    assert(result.stdout.includes('search_model'), 'Should list search_model tool')
  })

  test('--version shows version number', async () => {
    const result = await runCliCommand(['--version'])

    assert.equal(result.code, 0, 'Command should exit with code 0')
    assert(/^\d+\.\d+\.\d+/.test(result.stdout.trim()), 'Should print a semver version')
  })

  test('unknown flag shows help and exits with error', async () => {
    const result = await runCliCommand(['--foo'])

    assert.equal(result.code, 1, 'Command should exit with code 1')
    assert(result.stderr.includes('Usage: cds-mcp'), 'Should show usage in stderr')
  })

  test('--download rejects extra arguments', async () => {
    const result = await runCliCommand(['--download', '--help'])

    assert.equal(result.code, 1, 'Command should exit with code 1')
    assert(result.stderr.includes('must be the only argument'), 'Should show error message')
  })

  test('--download returns commitId info', async () => {
    const result = await runCliCommand(['--download'], {
      env: {
        ...process.env,
        CDS_MCP_TEST_BUNDLE_PATH: ctx.bundlePath,
        CDS_MCP_TEST_BUNDLE_VERSION: TEST_COMMIT_ID,
        NODE_OPTIONS: `--import "${mockFetchUrl}"`
      }
    })

    assert.equal(result.code, 0, 'Command should exit with code 0')
    const output = JSON.parse(result.stdout)
    assert(typeof output.commitId === 'string', 'Should return a commitId string')
    assert(typeof output.updated === 'boolean', 'Should return an updated boolean')
  })

  test('--offline search_docs works without downloading', async () => {
    const result = await runCliCommand(['--offline', 'search_docs', 'select statement'], {
      env: noFetchEnv
    })

    assert.equal(result.code, 0, 'Command should exit with code 0')
    assert(result.stdout.length > 0, 'Should produce output')
    assert(result.stdout.includes('---'), 'Output should contain document separators')
  })

  test('--offline is incompatible with --download', async () => {
    const result = await runCliCommand(['--offline', '--download'])

    assert.equal(result.code, 1, 'Command should exit with code 1')
    assert(result.stderr.includes('must be the only argument'), 'Should show error message')
  })

  test('CDS_MCP_OFFLINE=true search_docs works without downloading', async () => {
    const result = await runCliCommand(['search_docs', 'select statement'], {
      env: { ...noFetchEnv, CDS_MCP_OFFLINE: 'true' }
    })

    assert.equal(result.code, 0, 'Command should exit with code 0')
    assert(result.stdout.length > 0, 'Should produce output')
    assert(result.stdout.includes('---'), 'Output should contain document separators')
  })

  test('no arguments starts MCP server mode', async () => {
    let stderr = ''
    const child = spawn('node', [cdsMcpPath], { stdio: 'pipe' })
    child.stderr.on('data', d => {
      stderr += d
    })

    await new Promise(resolve => setTimeout(resolve, 100))

    child.kill('SIGTERM')
    const exitCode = await new Promise(resolve => child.on('close', resolve))

    assert(exitCode === 0 || exitCode === null, `server crashed on startup (code=${exitCode}): ${stderr}`)
  })

  test('--model flag routes bundle download under model-scoped dir', async () => {
    const altModel = 'test-org/test-model'
    const altFolder = 'test-org--test-model'
    const altDir = join(DEFAULT_DIR, altFolder)
    await fs.rm(altDir, { recursive: true, force: true }).catch(() => {})

    try {
      const result = await runCliCommand(['--model', altModel, '--download'], {
        env: {
          ...process.env,
          CDS_MCP_TEST_BUNDLE_PATH: ctx.bundlePath,
          CDS_MCP_TEST_BUNDLE_VERSION: TEST_COMMIT_ID,
          NODE_OPTIONS: `--import "${mockFetchUrl}"`
        }
      })

      assert.equal(result.code, 0, 'Command should exit with code 0')
      const output = JSON.parse(result.stdout)
      assert.strictEqual(output.commitId, TEST_COMMIT_ID)

      // Bundle written under the alt model dir
      const bundleJson = join(altDir, TEST_COMMIT_ID, 'code-chunks.json')
      const exists = await fs
        .access(bundleJson)
        .then(() => true)
        .catch(() => false)
      assert.ok(exists, `bundle must land under ${altDir}`)

      // Etag written under alt model's own etags subdir
      const etagFile = join(altDir, 'etags')
      const etagExists = await fs
        .access(etagFile)
        .then(() => true)
        .catch(() => false)
      assert.ok(etagExists, `etag dir must land under ${etagFile}`)
    } finally {
      await fs.rm(altDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('CDS_MCP_MODEL env routes bundle download under model-scoped dir', async () => {
    const altModel = 'env-org/env-model'
    const altFolder = 'env-org--env-model'
    const altDir = join(DEFAULT_DIR, altFolder)
    await fs.rm(altDir, { recursive: true, force: true }).catch(() => {})

    try {
      const result = await runCliCommand(['--download'], {
        env: {
          ...process.env,
          CDS_MCP_MODEL: altModel,
          CDS_MCP_TEST_BUNDLE_PATH: ctx.bundlePath,
          CDS_MCP_TEST_BUNDLE_VERSION: TEST_COMMIT_ID,
          NODE_OPTIONS: `--import "${mockFetchUrl}"`
        }
      })

      assert.equal(result.code, 0, 'Command should exit with code 0')
      const bundleJson = join(altDir, TEST_COMMIT_ID, 'code-chunks.json')
      const exists = await fs
        .access(bundleJson)
        .then(() => true)
        .catch(() => false)
      assert.ok(exists, `bundle must land under ${altDir}`)
    } finally {
      await fs.rm(altDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
