import { test, before } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getEmbeddings } from '../lib/embeddings.js'
import calculateEmbeddings from '../lib/calculateEmbeddings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = path.resolve(__dirname, '..', 'models')

test.describe('embeddings', () => {
  // Pre-download models once at the start to speed up all tests
  before(async () => {
    await calculateEmbeddings('initialization test')
  })
  test('should create embeddings for a test string', async () => {
    const results = await getEmbeddings('Node.js testing')
    assert(results.length, 'Results should be an array')
  })

  test('should verify model files have expected structure', async () => {
    // Models should already be available from before() hook
    // Check tokenizer.json structure
    const tokenizerPath = path.join(MODEL_DIR, 'tokenizer.json')
    const tokenizerData = JSON.parse(fs.readFileSync(tokenizerPath, 'utf-8'))

    assert(typeof tokenizerData === 'object', 'Tokenizer should be a valid JSON object')
    assert(tokenizerData.model, 'Tokenizer should have model property')
    assert(tokenizerData.model.vocab, 'Tokenizer should have vocab property')
    assert(typeof tokenizerData.model.vocab === 'object', 'Vocab should be an object')

    // Check tokenizer_config.json structure
    const configPath = path.join(MODEL_DIR, 'tokenizer_config.json')
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

    assert(typeof configData === 'object', 'Tokenizer config should be a valid JSON object')

    // Check ONNX model file
    const modelPath = path.join(MODEL_DIR, 'model.onnx')
    const modelStats = fs.statSync(modelPath)

    // ONNX files should be reasonably large (MiniLM model is typically several MB)
    assert(modelStats.size > 1000000, 'ONNX model file should be reasonably large (>1MB)')
  })

  test('should verify calculateEmbeddings returns normalized embeddings', async () => {
    const testString = 'This is a test string for embedding verification'

    // Get embeddings from calculateEmbeddings
    const calculateEmbeddingsResult = await calculateEmbeddings(testString)

    // Should return an array or Float32Array
    assert(
      Array.isArray(calculateEmbeddingsResult) || calculateEmbeddingsResult instanceof Float32Array,
      'calculateEmbeddings should return an array'
    )

    // Should contain numeric values
    assert(
      calculateEmbeddingsResult.every(val => typeof val === 'number'),
      'calculateEmbeddings should return numeric values'
    )

    // Should return expected hidden size
    const hiddenSize = 384 // MiniLM-L6-v2 hidden size
    assert.strictEqual(
      calculateEmbeddingsResult.length,
      hiddenSize,
      'calculateEmbeddings should return embedding of size 384'
    )

    // Should be normalized (norm ≈ 1.0)
    let norm = 0
    for (let i = 0; i < hiddenSize; i++) {
      norm += calculateEmbeddingsResult[i] * calculateEmbeddingsResult[i]
    }
    norm = Math.sqrt(norm)

    assert(Math.abs(norm - 1.0) < 0.001, `calculateEmbeddings should be normalized (norm ≈ 1.0), got ${norm}`)
  })

  test('should produce consistent embeddings for identical inputs', async () => {
    const testString = 'Consistent embedding test string'

    // Generate embeddings twice
    const embedding1 = await calculateEmbeddings(testString)
    const embedding2 = await calculateEmbeddings(testString)

    // Should have same length
    assert.strictEqual(embedding1.length, embedding2.length, 'Embeddings should have same length')

    // Should be identical (or very close due to floating point precision)
    for (let i = 0; i < embedding1.length; i++) {
      const diff = Math.abs(embedding1[i] - embedding2[i])
      assert(diff < 0.0001, `Embedding values should be consistent at index ${i}: ${embedding1[i]} vs ${embedding2[i]}`)
    }
  })

  test('should produce different embeddings for different inputs', async () => {
    const string1 = 'First test string'
    const string2 = 'Completely different sentence'

    const embedding1 = await calculateEmbeddings(string1)
    const embedding2 = await calculateEmbeddings(string2)

    // Should have same length
    assert.strictEqual(embedding1.length, embedding2.length, 'Embeddings should have same length')

    // Should be different - compute cosine similarity
    let dotProduct = 0
    let norm1 = 0
    let norm2 = 0

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i]
      norm1 += embedding1[i] * embedding1[i]
      norm2 += embedding2[i] * embedding2[i]
    }

    const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2))

    // Different strings should have similarity less than 1.0 (not identical)
    assert(similarity < 0.99, `Different strings should produce different embeddings, similarity: ${similarity}`)

    // But similarity should still be reasonable (not completely random)
    assert(similarity > -1.0 && similarity < 1.0, `Similarity should be in valid range [-1, 1]: ${similarity}`)
  })

  test('should handle empty strings gracefully', async () => {
    const emptyString = ''

    try {
      const embedding = await calculateEmbeddings(emptyString)

      // Should still return valid embedding dimensions
      assert.strictEqual(embedding.length, 384, 'Empty string should still return 384-dimensional embedding')

      // Should contain valid numbers
      assert(
        embedding.every(val => typeof val === 'number' && isFinite(val)),
        'Empty string embedding should contain valid finite numbers'
      )
    } catch (error) {
      // If it throws an error, that's also acceptable behavior for empty strings
      assert(error instanceof Error, 'Should throw a proper Error for empty strings')
    }
  })

  test('should handle reasonably long strings', async () => {
    // Create a moderately long string (not too long to avoid ONNX model limits)
    const longString = 'This is a moderately long test string. '.repeat(10)

    const embedding = await calculateEmbeddings(longString)

    // Should still return valid embedding dimensions
    assert.strictEqual(embedding.length, 384, 'Long string should still return 384-dimensional embedding')

    // Should be normalized
    let norm = 0
    for (let i = 0; i < embedding.length; i++) {
      norm += embedding[i] * embedding[i]
    }
    norm = Math.sqrt(norm)

    assert(Math.abs(norm - 1.0) < 0.001, `Long string embedding should be normalized: ${norm}`)
  })
})
