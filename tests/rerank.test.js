import { test, describe } from 'node:test'
import assert from 'node:assert'
import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers'
import { rerank, getReranker } from '../lib/rerank.js'
import { hybridSearch, loadChunks } from '../lib/embeddings.js'
import { resolveLocalVersion } from '../lib/searchMarkdownDocs.js'

// These tests require the reranker model to be downloaded.
// They run against the real ONNX model — no mocks.

describe('rerank', () => {
  test('relevant document scores higher than irrelevant one', async () => {
    const query = 'How do I bake a chocolate cake?'
    const docs = [
      { content: 'Mars is the fourth planet from the Sun.' },
      { content: 'Mix flour, sugar, cocoa powder, eggs and butter. Bake at 180C for 35 minutes.' },
    ]
    const ranked = await rerank(query, docs, 2)

    assert.strictEqual(ranked.length, 2)
    assert(ranked[0].score > ranked[1].score, 'results must be sorted by descending score')
    assert(
      ranked[0].content.includes('flour') || ranked[0].content.includes('Bake'),
      'cake recipe must be ranked first'
    )
  })

  // Regression: TextClassificationPipeline.call ignores function_to_apply and applies
  // softmax — for a single-logit model softmax([x]) === 1.0 always, collapsing all
  // scores to 1.  The fix uses AutoTokenizer + AutoModelForSequenceClassification
  // directly so raw logits are returned.
  test('scores must differ across clearly different documents', async () => {
    const query = 'What is the capital of France?'
    const docs = [
      { content: 'Paris is the capital and most populous city of France.' },
      { content: 'Node.js is a JavaScript runtime built on V8 for server-side code.' },
    ]
    const ranked = await rerank(query, docs, 2)

    assert.notStrictEqual(
      ranked[0].score, ranked[1].score,
      'identical scores for all documents means the softmax-of-single-value regression is back'
    )
    assert(ranked[0].score > ranked[1].score, 'results must be sorted by descending score')
  })

  test('topK limits returned results to the most relevant', async () => {
    const query = 'What is the capital of France?'
    const docs = [
      { content: 'Paris is the capital of France.' },
      { content: 'Berlin is the capital of Germany.' },
      { content: 'Node.js is a JavaScript runtime built on V8.' },
    ]
    const ranked = await rerank(query, docs, 1)
    assert.strictEqual(ranked.length, 1)
    assert(ranked[0].content.includes('Paris'), 'most relevant result must be returned')
  })

  test('original result properties are preserved in output', async () => {
    const query = 'How do I bake a cake?'
    const docs = [
      { content: 'Mix flour and eggs.', meta: { title: 'Baking' } },
      { content: 'Mars is far from Earth.', meta: { title: 'Astronomy' } },
    ]
    const ranked = await rerank(query, docs, 2)
    for (const r of ranked) {
      const original = docs.find(d => d.content === r.content)
      assert.deepStrictEqual(r.meta, original.meta, 'meta must be preserved')
      assert(typeof r.score === 'number', 'score must be a number')
    }
  })

  test('getReranker returns the same model instance on concurrent calls', async () => {
    const [r1, r2] = await Promise.all([getReranker(), getReranker()])
    assert.strictEqual(r1, r2, 'must resolve to the same [tokenizer, model] tuple to prevent double model loading')
  })
})


describe('rerank model benchmark', () => {
  //  Model                                      k=1 (10 cands)    k=5 (50 cands)
  //                                             ms      ΔRSS      ms     ΔRSS
  //  ──────────────────────────────────────  ──────  ───────  ──────  ────────
  //  Xenova/ms-marco-TinyBERT-L-2-v2             28   +41 MB     119   +236 MB
  //  Xenova/ms-marco-MiniLM-L-2-v2               87  +264 MB     472  +1402 MB
  //  Xenova/ms-marco-MiniLM-L-4-v2              157  +264 MB     752  +1399 MB
  //  jinaai/jina-reranker-v1-tiny-en             219  +311 MB    1023  +1581 MB
  //  Xenova/ms-marco-MiniLM-L-6-v2              253  +252 MB    1096  +1427 MB
  //  Xenova/ms-marco-MiniLM-L-12-v2             601  +337 MB    2086  +1394 MB
  //  mixedbread-ai/mxbai-rerank-xsmall-v1      1038  +465 MB    4871  +2380 MB
  //  mixedbread-ai/mxbai-rerank-base-v1        2296  +350 MB   12122  +4373 MB
  test.skip('inference time and ΔRSS for each model (20 candidates, max_length=256, dtype=q8)', async () => {
    const MODELS = [
      'Xenova/ms-marco-TinyBERT-L-2-v2',
      'Xenova/ms-marco-MiniLM-L-6-v2',
      'Xenova/ms-marco-MiniLM-L-12-v2',
      'cross-encoder/ms-marco-MiniLM-L-6-v2',
      'jinaai/jina-reranker-v1-tiny-en',
      'jinaai/jina-reranker-v2-base-multilingual',
      'mixedbread-ai/mxbai-rerank-xsmall-v1',
      'mixedbread-ai/mxbai-rerank-base-v1',
      'BAAI/bge-reranker-base',
      'BAAI/bge-reranker-v2-m3',
    ]

    const { localDir } = await resolveLocalVersion()
    const chunks = await loadChunks('code-chunks', localDir)
    const query = 'How do I use Markdown rendering in CAP code?'
    const candidates = (await hybridSearch(query, chunks)).slice(0, 10)
    const queries = candidates.map(() => query)
    const docs = candidates.map(r => r.content)

    const rows = []
    for (const model_id of MODELS) {
      try {
        const [tok, model] = await Promise.all([
          AutoTokenizer.from_pretrained(model_id),
          AutoModelForSequenceClassification.from_pretrained(model_id, { dtype: 'q8' }),
        ])
        await model(tok([query], { text_pair: [docs[0]], padding: true, truncation: true, max_length: 256 }))

        const rss0 = process.memoryUsage().rss
        const t0 = performance.now()
        await model(tok(queries, { text_pair: docs, padding: true, truncation: true, max_length: 256 }))
        rows.push({ model_id, ms: (performance.now() - t0).toFixed(0), drss: ((process.memoryUsage().rss - rss0) / 1024 / 1024).toFixed(0) })
      } catch (e) {
        rows.push({ model_id, ms: 'ERR', drss: e.message.split('\n')[0].substring(0, 40) })
      }
    }

    // eslint-disable-next-line no-console
    console.error(`\n${'Model'.padEnd(45)} ${'Inference'.padStart(10)} ${'ΔRSS'.padStart(9)}`)
    // eslint-disable-next-line no-console
    console.error('-'.repeat(67))
    for (const { model_id, ms, drss } of rows) {
      const msCol = ms === 'ERR' ? 'ERR' : ms + ' ms'
      const rssCol = ms === 'ERR' ? drss : '+' + drss + ' MB'
      // eslint-disable-next-line no-console
      console.error(`${model_id.padEnd(45)} ${msCol.padStart(10)} ${rssCol.padStart(9)}`)
    }
  })
})
