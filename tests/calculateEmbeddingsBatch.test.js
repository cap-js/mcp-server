import { test, describe } from 'node:test'
import assert from 'node:assert'
import calculateEmbeddings, { calculateEmbeddingsBatch } from '../lib/calculateEmbeddings.js'

function arraysAlmostEqual(arr1, arr2, tolerance = 1e-6) {
  if (arr1.length !== arr2.length) return false

  for (let i = 0; i < arr1.length; i++) {
    if (Math.abs(arr1[i] - arr2[i]) > tolerance) {
      return false
    }
  }
  return true
}

describe('calculateEmbeddingsBatch', () => {
  test('should produce same results as individual calls for simple texts', async () => {
    const texts = ['hello world', 'goodbye world', 'test string']

    // Get individual embeddings
    const individualEmbeddings = await Promise.all(texts.map(text => calculateEmbeddings(text)))

    // Get batch embeddings
    const batchEmbeddings = await calculateEmbeddingsBatch(texts)

    // Verify same number of results
    assert.strictEqual(batchEmbeddings.length, individualEmbeddings.length)
    assert.strictEqual(batchEmbeddings.length, texts.length)

    // Verify each embedding matches
    for (let i = 0; i < texts.length; i++) {
      assert.ok(
        arraysAlmostEqual(individualEmbeddings[i], batchEmbeddings[i]),
        `Embedding ${i} for text "${texts[i]}" does not match between individual and batch processing`
      )
    }
  })

  test('should handle single text input', async () => {
    const text = 'single test string'

    const individual = await calculateEmbeddings(text)
    const batch = await calculateEmbeddingsBatch([text])

    assert.strictEqual(batch.length, 1)
    assert.ok(arraysAlmostEqual(individual, batch[0]), 'Single text batch result should match individual result')
  })

  test('should handle empty array input', async () => {
    await assert.rejects(() => calculateEmbeddingsBatch([]), /Input must be a non-empty array of strings/)
  })

  test('should handle different length texts', async () => {
    const texts = ['short', 'this is a medium length sentence with some words', 'a']

    const individualEmbeddings = await Promise.all(texts.map(text => calculateEmbeddings(text)))

    const batchEmbeddings = await calculateEmbeddingsBatch(texts)

    assert.strictEqual(batchEmbeddings.length, texts.length)

    for (let i = 0; i < texts.length; i++) {
      assert.ok(
        arraysAlmostEqual(individualEmbeddings[i], batchEmbeddings[i]),
        `Variable length embedding ${i} does not match`
      )
    }
  })

  test('should produce normalized embeddings', async () => {
    const texts = ['test vector normalization', 'another test vector']
    const embeddings = await calculateEmbeddingsBatch(texts)

    for (let i = 0; i < embeddings.length; i++) {
      // Calculate L2 norm
      let norm = 0
      for (let j = 0; j < embeddings[i].length; j++) {
        norm += embeddings[i][j] * embeddings[i][j]
      }
      norm = Math.sqrt(norm)

      // Should be approximately 1.0 (normalized)
      assert.ok(Math.abs(norm - 1.0) < 1e-6, `Embedding ${i} is not normalized (norm: ${norm})`)
    }
  })

  test('should handle special characters and punctuation', async () => {
    const texts = ['Hello, world!', 'Test with "quotes" and symbols: @#$%', 'Unicode: café, naïve, résumé']

    const individualEmbeddings = await Promise.all(texts.map(text => calculateEmbeddings(text)))

    const batchEmbeddings = await calculateEmbeddingsBatch(texts)

    for (let i = 0; i < texts.length; i++) {
      assert.ok(
        arraysAlmostEqual(individualEmbeddings[i], batchEmbeddings[i]),
        `Special character embedding ${i} does not match`
      )
    }
  })
})
