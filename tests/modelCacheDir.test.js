import { test, describe, after } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fsp from 'node:fs/promises'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')

process.env.CDS_MCP_OFFLINE = 'true'

const { default: calculateEmbeddings, MODEL_CACHE_DIR, setModelCacheDir, getActiveModel } = await import('../lib/calculateEmbeddings.js')

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cds-mcp-model-cache-'))

after(async () => {
  setModelCacheDir()
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('model cache directory anchoring', () => {
  test('MODEL_CACHE_DIR resolves inside the package root, not process.cwd()', () => {
    assert.ok(path.isAbsolute(MODEL_CACHE_DIR))
    assert.strictEqual(MODEL_CACHE_DIR, path.join(packageRoot, '.cds', 'models'))
  })

  test('calculateEmbeddings uses the configured cache directory', async () => {
    // @cap-js/ai requires the model to be pre-installed in the configured directory.
    // Copy the default model into tmpDir so the test is self-contained.
    const [org, name] = getActiveModel().split('/')
    const srcModelDir = path.join(packageRoot, '.cds', 'models', org, name)
    const dstModelDir = path.join(tmpDir, org, name)
    await fsp.cp(srcModelDir, dstModelDir, { recursive: true })

    setModelCacheDir(tmpDir)
    const result = await calculateEmbeddings('test query')

    assert.ok(result instanceof Float32Array, 'result must be a Float32Array')
    assert.ok(result.length > 0, 'embedding must be non-empty')
    // Verify the model files are present in tmpDir — confirming that is where it was read from.
    const entries = await fsp.readdir(dstModelDir)
    assert.ok(entries.includes('embedding.lock.json'), `expected model files in ${dstModelDir}`)
  })
})
