import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

process.env.CDS_MCP_OFFLINE = 'true'
let connectionError
let executionError
let embedding = '[1,0]'
mock.module('@sap/cds', {
  defaultExport: {
    connect: {
      to: async (_name, options) => {
        if (connectionError) throw connectionError
        return {
          options,
          disconnect: async () => {},
          run: async () => {
            if (executionError) throw executionError
            return [{ emb: embedding }]
          }
        }
      }
    }
  }
})
const { default: calculateEmbeddings } = await import('../lib/calculateEmbeddings.js')
beforeEach(() => {
  connectionError = undefined
  executionError = undefined
  embedding = '[1,0]'
})

for (const [kind, diagnostic] of [
  ['missing', (model) => `Embedding model '${model}' is not available in offline mode.`],
  ['invalid lock', () => 'Invalid embedding model lock at /models/model.lock.json.'],
  ['corrupt', () => 'Embedding model is not provisioned or failed integrity checks in /models.'],
  [
    'package override',
    () => 'Embedding model lock not found at /package/.cds/models/model.lock.json.'
  ]
]) {
  test(`offline ${kind} query model gets preparation advice with the original cause`, async () => {
    const model = `test/${kind.replaceAll(' ', '-')}`
    const directory = kind === 'package override' ? ' --directory /package/.cds/models' : ''
    connectionError = new Error(
      `${diagnostic(model)} Run 'npx @cap-js/ai install-model ${model}${directory}'.`
    )
    await assert.rejects(calculateEmbeddings('query', model), (error) => {
      assert.equal(error.cause, connectionError)
      assert.match(error.message, new RegExp(`cds-mcp --download --model ${model}`))
      assert.ok(error.message.startsWith(connectionError.message))
      return true
    })
    connectionError = undefined
  })
}

for (const [kind, message] of [
  ['connection', 'EACCES: unable to open database file'],
  ['initialization', 'Cannot initialize the model tokenizer'],
  ['plain model error', "Embedding model 'test/plain-model-error' failed to initialize"],
  [
    'other model diagnostic',
    "Embedding model 'other/model' is not available in offline mode. Run 'npx @cap-js/ai install-model other/model'."
  ]
]) {
  test(`offline unrelated ${kind} failure is rethrown unchanged`, async () => {
    connectionError = new Error(message)
    await assert.rejects(
      calculateEmbeddings('query', `test/${kind.replaceAll(' ', '-')}`),
      (error) => error === connectionError
    )
    connectionError = undefined
  })
}

for (const kind of ['SQL', 'inference']) {
  test(`offline ${kind} execution failure is rethrown unchanged`, async () => {
    executionError = new Error(`${kind} failed`)
    await assert.rejects(
      calculateEmbeddings('query', `test/${kind}`),
      (error) => error === executionError
    )
    executionError = undefined
  })
}

test('offline malformed embedding JSON preserves the parsing error unchanged', async (t) => {
  embedding = 'invalid-json'
  const failure = new SyntaxError('Malformed embedding JSON')
  const parse = JSON.parse
  t.mock.method(JSON, 'parse', (value, ...args) => {
    if (value === embedding) throw failure
    return parse(value, ...args)
  })
  await assert.rejects(calculateEmbeddings('query', 'test/parse'), (error) => error === failure)
})

test('offline available query model returns its vector', async () => {
  assert.deepEqual(await calculateEmbeddings('query', 'test/available'), new Float32Array([1, 0]))
})
