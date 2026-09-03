import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'
import { test } from 'node:test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.CDS_MCP_CACHE_DIR = path.join(__dirname, 'custom-cache')

const { CACHE_DIR, MODEL_DIR } = await import('../lib/cache.js')

test('uses the configured cache directory for model artifacts', () => {
  assert.equal(CACHE_DIR, path.resolve(__dirname, 'custom-cache'))
  assert.equal(MODEL_DIR, path.join(CACHE_DIR, 'models'))
})
