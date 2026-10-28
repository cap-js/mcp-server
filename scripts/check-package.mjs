import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)))
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'Run this check with npm run test:package')

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cds-mcp-package-'))
const prefix = path.join(tempDir, 'install')

function runNpm(args, cwd, capture = false) {
  // Invoke npm's JavaScript entry point without relying on Windows .cmd handling.
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    timeout: 300_000
  })
}

try {
  const [archive] = JSON.parse(
    runNpm(['pack', '--json', '--pack-destination', tempDir, '--ignore-scripts'], packageRoot, true)
  )
  const shrinkwrap = await readFile(path.join(packageRoot, 'npm-shrinkwrap.json'), 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  if (shrinkwrap) {
    assert.ok(
      archive.files.some(({ path }) => path === 'npm-shrinkwrap.json'),
      'An adopted shrinkwrap must be included in the published package'
    )
  }
  const expectedRuntime = shrinkwrap?.packages['node_modules/onnxruntime-node'].version
  const npmMajor = Number(runNpm(['--version'], packageRoot, true).split('.')[0])
  const allowScripts = npmMajor >= 11 ? ['--allow-scripts=onnxruntime-node,protobufjs'] : []

  runNpm(
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts=false',
      ...allowScripts,
      '--no-audit',
      '--no-fund',
      path.join(tempDir, archive.filename)
    ],
    tempDir
  )
  const globalRoot = runNpm(['root', '--global', '--prefix', prefix], tempDir, true).trim()
  const installedRoot = path.join(globalRoot, '@cap-js', 'mcp-server')
  if (shrinkwrap) {
    assert.deepEqual(
      JSON.parse(await readFile(path.join(installedRoot, 'npm-shrinkwrap.json'), 'utf8')),
      shrinkwrap,
      'The installed package must retain its published shrinkwrap'
    )
  }

  execFileSync(
    process.execPath,
    [
      '--import',
      new URL('./private-model-cache.mjs', import.meta.url).href,
      fileURLToPath(new URL('./smoke-installed-package.mjs', import.meta.url)),
      installedRoot,
      expectedRuntime ?? ''
    ],
    {
      cwd: prefix,
      stdio: 'inherit',
      timeout: 300_000,
      env: {
        ...process.env,
        CDS_MCP_MODEL: 'BAAI/bge-small-en-v1.5',
        CDS_MCP_TEST_CACHE_HOME: path.join(tempDir, 'model-cache-home'),
        CDS_MCP_OFFLINE: 'true',
        CDS_MCP_RERANK_ENABLED: 'false',
        RERANK_ENABLED: 'false'
      }
    }
  )
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
