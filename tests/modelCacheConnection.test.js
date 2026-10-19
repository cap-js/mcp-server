import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

const selectedRoot = path.join(os.tmpdir(), 'selected-model-cache')
const calls = []
mock.module('../lib/modelCache.js', {
  namedExports: {
    MODEL_CACHE_DIR: selectedRoot,
    LOCAL_MODEL_CACHE_DIR: path.join(os.tmpdir(), 'package-model-cache'),
    resolveModelCache: async model => {
      calls.push({ model })
      return selectedRoot
    }
  }
})
mock.module('@sap/cds', {
  defaultExport: {
    connect: {
      to: async (name, options) => {
        calls.push({ name, options })
        return { options }
      }
    }
  }
})
const { getQueryDb } = await import('../lib/calculateEmbeddings.js')

test('SQLite uses the selected embedding model cache explicitly', async () => {
  const model = 'BAAI/bge-small-en-v1.5'
  const db = await getQueryDb(model)
  assert.deepEqual(db.options.embedding, { model, directory: selectedRoot })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { model })
  assert.equal(calls[1].name, 'embed-db')
  assert.equal(await getQueryDb(model), db)
  assert.equal(calls.length, 2)
})
