import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it, mock } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import cds from '@sap/cds'
import { MODEL_CACHE_ROOT } from '../../lib/calculateEmbeddings.js'

let modelDir
let maxLength = 12
let documentPrompt = 'doc:'
const resolveModel = mock.fn(async () => ({
  modelDir,
  model: {
    maxLength,
    prompts: { document: documentPrompt },
    files: [
      { role: 'tokenizer', name: 'tokenizer.json' },
      { role: 'tokenizerConfig', name: 'tokenizer_config.json' }
    ]
  }
}))

mock.module('@cap-js/ai/lib/vector_embedding/model-utils.js', {
  namedExports: {
    fileForRole: (model, role) => model.files.find((file) => file.role === role),
    loadTokenizerPackage: async () => ({
      Tokenizer: class {
        encode(text) {
          return { ids: [...text] }
        }
      }
    })
  }
})
mock.module('@cap-js/ai/lib/vector_embedding/embedding.js', {
  namedExports: {
    resolveEmbeddingModel: resolveModel,
    createTokenizerState: (_tokenizer, length) => ({
      maxLength: length,
      prefix: { ids: [1] },
      suffix: { ids: [2] }
    })
  }
})

const { createTokenMeasure } = await import('../../lib/markdownEmbeddings/chunker/tokenizer.js')

before(async () => {
  modelDir = await mkdtemp(join(tmpdir(), 'mcp-tokenizer-'))
  await writeFile(join(modelDir, 'tokenizer.json'), '{}')
  await writeFile(join(modelDir, 'tokenizer_config.json'), '{}')
})

after(() => rm(modelDir, { recursive: true, force: true }))
afterEach(() => {
  resolveModel.mock.resetCalls()
  maxLength = 12
  documentPrompt = 'doc:'
})

describe('generation tokenizer', () => {
  it('should resolve model artifacts using the SQLite inference configuration and caller root', async () => {
    const model = 'fixture/tokenizer-model'

    await createTokenMeasure(model)

    const [configuration, options] = resolveModel.mock.calls[0].arguments
    assert.equal(configuration.model, model)
    assert.equal(configuration.root, MODEL_CACHE_ROOT)
    assert.equal(options.root, cds.root)
  })

  it('should subtract special tokens and the document prompt from the content budget', async () => {
    const { measure, maxTokens } = await createTokenMeasure('fixture/tokenizer-model')

    assert.equal(measure('text'), 4)
    assert.equal(maxTokens, 6)
  })

  it('should reject a missing model before resolving artifacts', async () => {
    await assert.rejects(createTokenMeasure(), /modelId is required/)

    assert.equal(resolveModel.mock.callCount(), 0)
  })

  it('should reject a model whose overhead leaves no content budget', async () => {
    maxLength = 6

    await assert.rejects(createTokenMeasure('fixture/tokenizer-model'), /no token budget/)
  })
})
