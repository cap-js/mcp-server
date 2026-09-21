import { test, describe } from 'node:test'
import assert from 'node:assert'
import { rerank } from '../lib/rerank.js'

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
})
