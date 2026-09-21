import { test, describe } from 'node:test'
import assert from 'node:assert'
import { rerank, getReranker } from '../lib/rerank.js'

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
