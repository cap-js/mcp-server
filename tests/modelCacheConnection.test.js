import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const calls = []
const callerRoot = '/caller-project'
mock.module('@sap/cds', {
  defaultExport: {
    root: callerRoot,
    connect: {
      to: async (name, options) => {
        calls.push({ name, options })
        return { options }
      }
    }
  }
})
const { getQueryDb, MODEL_CACHE_ROOT } = await import('../lib/calculateEmbeddings.js')
const { default: cds } = await import('@sap/cds')

test('SQLite delegates cache selection to AI with a package-root lookup override', async () => {
  const model = 'BAAI/bge-small-en-v1.5'
  const db = await getQueryDb(model)
  assert.equal(MODEL_CACHE_ROOT, packageRoot)
  assert.deepEqual(db.options.embedding, { model, root: packageRoot })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'embed-db')
  assert.equal(cds.root, callerRoot)
  assert.equal(await getQueryDb(model), db)
  assert.equal(calls.length, 1)
})
