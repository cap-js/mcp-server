import { test, describe, mock, after } from 'node:test'
import assert from 'node:assert'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { setEmbeddingsDir } from '../lib/calculateEmbeddings.js'
import { buildTestBundle } from './helpers/test-bundle.js'

// All five rerank constants are evaluated at module load time in rerank.js.
// Set them before the dynamic imports below or they pick up the defaults.
process.env.RERANK_ENABLED = 'true'
process.env.CDS_MCP_RERANK_MODEL = 'test-org/test-reranker'
process.env.CDS_MCP_RERANK_DTYPE = 'fp32'
process.env.CDS_MCP_RERANK_EXTERNAL_DATA = 'true'
process.env.CDS_MCP_RERANK_BATCH_SIZE = '2'

const pretrainedCalls = []
let modelCallCount = 0

// mock.module must precede the dynamic import of rerank.js (which statically imports this).
mock.module('@huggingface/transformers', {
    namedExports: {
        AutoTokenizer: {
            from_pretrained: async (model) => {
                pretrainedCalls.push({ kind: 'tokenizer', model })
                // Return a callable tokenizer; rerank() passes the return value straight
                // to the model, so any shape works as long as the model handles it.
                return (queries) => ({ queries })
            }
        },
        AutoModelForSequenceClassification: {
            from_pretrained: async (model, opts) => {
                pretrainedCalls.push({ kind: 'model', model, opts })
                return async (features) => {
                    modelCallCount++
                    return { logits: { tolist: () => features.queries.map((_, i) => [i]) } }
                }
            }
        }
    }
})

const tmpDir = await fsp.mkdtemp(os.tmpdir() + '/rerank-config-')
setEmbeddingsDir(tmpDir)

// Satisfy the module-load-time downloadEmbeddings() call in searchMarkdownDocs.js.
let _frame = null
mock.method(globalThis, 'fetch', async () => {
    if (!_frame) _frame = buildTestBundle()
    return new Response(await _frame, {
        status: 200,
        headers: { etag: 'W/"__test__"', 'x-embeddings-version': '__test__', 'content-type': 'application/octet-stream' }
    })
})

const { RERANK_ENABLED, getReranker, rerank } = await import('../lib/rerank.js')
const { default: searchMarkdownDocs } = await import('../lib/searchMarkdownDocs.js')

after(async () => {
    mock.restoreAll()
    setEmbeddingsDir()
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('env var → model options', () => {
    test('RERANK_ENABLED is true when env var is "true"', () => {
        assert.strictEqual(RERANK_ENABLED, true)
    })

    test('CDS_MCP_RERANK_MODEL is passed to AutoTokenizer.from_pretrained', async () => {
        await getReranker()
        assert.strictEqual(pretrainedCalls.find(c => c.kind === 'tokenizer')?.model, 'test-org/test-reranker')
    })

    test('CDS_MCP_RERANK_MODEL is passed to AutoModelForSequenceClassification.from_pretrained', async () => {
        await getReranker()
        assert.strictEqual(pretrainedCalls.find(c => c.kind === 'model')?.model, 'test-org/test-reranker')
    })

    test('CDS_MCP_RERANK_DTYPE is passed as dtype option to AutoModelForSequenceClassification.from_pretrained', async () => {
        await getReranker()
        assert.strictEqual(pretrainedCalls.find(c => c.kind === 'model')?.opts?.dtype, 'fp32')
    })

    test('CDS_MCP_RERANK_EXTERNAL_DATA is passed as use_external_data_format option', async () => {
        await getReranker()
        assert.strictEqual(pretrainedCalls.find(c => c.kind === 'model')?.opts?.use_external_data_format, true)
    })

    test('CDS_MCP_RERANK_BATCH_SIZE=2 processes 4 items in 2 model calls', async () => {
        const prev = modelCallCount
        await rerank('test query', [{ content: 'a' }, { content: 'b' }, { content: 'c' }, { content: 'd' }])
        assert.strictEqual(modelCallCount - prev, 2)
    })
})

describe('searchMarkdownDocs integration', () => {
    test('RERANK_ENABLED=true causes searchMarkdownDocs to invoke the reranker', async () => {
        const prev = modelCallCount
        await searchMarkdownDocs('entity definition', 3)
        assert.ok(modelCallCount > prev, `expected model calls during reranked search; got ${modelCallCount - prev}`)
    })

    test('RERANK_ENABLED=true over-retrieves candidates (maxResults * 5) before reranking', async () => {
        // maxResults=1, RERANK_OVER_RETRIEVE=5 → rerank() receives up to 5 candidates.
        // batch_size=2 → ceil(5/2) = 3 model calls. Without over-retrieve: 1 call.
        const prev = modelCallCount
        await searchMarkdownDocs('entity definition', 1)
        assert.ok(modelCallCount - prev > 1, `expected >1 model call from over-retrieve; got ${modelCallCount - prev}`)
    })
})
