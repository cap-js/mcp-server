import { test, describe, after } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fsp from 'node:fs/promises'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')

process.env.CDS_MCP_OFFLINE = 'true'

const { default: calculateEmbeddings, MODEL_CACHE_ROOT, setModelCacheRoot, getModelCacheDir, getActiveModel } = await import('../lib/calculateEmbeddings.js')

const defaultModelCacheRoot = MODEL_CACHE_ROOT
const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cds-mcp-model-cache-'))

after(async () => {
  setModelCacheRoot(defaultModelCacheRoot)
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('model cache directory anchoring', () => {
  test('model cache resolves inside the package root, not process.cwd()', () => {
    assert.ok(path.isAbsolute(MODEL_CACHE_ROOT))
    assert.strictEqual(MODEL_CACHE_ROOT, packageRoot)
    assert.strictEqual(getModelCacheDir(), path.join(packageRoot, '.cds', 'models'))
  })

  test('calculateEmbeddings reads the model from the configured cache root', async () => {
    // @cap-js/ai resolves the model under <cds.root>/.cds/models and requires it to be
    // pre-installed when offline. Copy the default model into the tmp root so the test
    // is self-contained, then point the cache root at the tmp dir.
    const [org, name] = getActiveModel().split('/')
    const srcModelDir = path.join(packageRoot, '.cds', 'models', org, name)
    const dstModelDir = path.join(tmpDir, '.cds', 'models', org, name)
    await fsp.cp(srcModelDir, dstModelDir, { recursive: true })

    setModelCacheRoot(tmpDir)
    const result = await calculateEmbeddings('test query')

    assert.ok(result instanceof Float32Array, 'result must be a Float32Array')
    assert.ok(result.length > 0, 'embedding must be non-empty')
    // Confirm the model was read from the configured tmp root.
    assert.strictEqual(getModelCacheDir(), path.join(tmpDir, '.cds', 'models'))
    const entries = await fsp.readdir(dstModelDir)
    assert.ok(entries.includes('embedding.lock.json'), `expected model files in ${dstModelDir}`)
  })
})
