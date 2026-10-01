import { test, describe, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getEmbeddings, createEmbeddings } from '../lib/embeddings.js'
import calculateEmbeddings, { getQueryDb } from '../lib/calculateEmbeddings.js'
import { mockFsWrites, getWrittenJson } from './helpers/mock-fs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = path.resolve(__dirname, '..', '.cds', 'models', 'sentence-transformers', 'all-MiniLM-L6-v2')
const REQUIRED_FILES = ['model.onnx', 'tokenizer.json', 'tokenizer_config.json']

describe('embeddings', () => {
  afterEach(() => mock.restoreAll())

  test('should create embeddings for a test string', async () => {
    const results = await getEmbeddings('Node.js testing')
    assert(results.length, 'Results should be an array')
  })

  test('should verify model files are downloaded correctly', async () => {
    assert(fs.existsSync(MODEL_DIR), 'Model directory should exist after initialization')

    for (const file of REQUIRED_FILES) {
      const filePath = path.join(MODEL_DIR, file)
      assert(fs.existsSync(filePath), `Required model file ${file} should exist`)

      const stats = fs.statSync(filePath)
      assert(stats.size > 0, `Model file ${file} should not be empty`)
    }
  })

  test('should verify model files have expected structure', async () => {
    const tokenizerPath = path.join(MODEL_DIR, 'tokenizer.json')
    const tokenizerData = JSON.parse(fs.readFileSync(tokenizerPath, 'utf-8'))

    assert(typeof tokenizerData === 'object', 'Tokenizer should be a valid JSON object')
    assert(tokenizerData.model, 'Tokenizer should have model property')
    assert(tokenizerData.model.vocab, 'Tokenizer should have vocab property')
    assert(typeof tokenizerData.model.vocab === 'object', 'Vocab should be an object')

    const configPath = path.join(MODEL_DIR, 'tokenizer_config.json')
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    assert(typeof configData === 'object', 'Tokenizer config should be a valid JSON object')

    const modelPath = path.join(MODEL_DIR, 'model.onnx')
    const modelStats = fs.statSync(modelPath)
    assert(modelStats.size > 1000000, 'ONNX model file should be reasonably large (>1MB)')
  })

  test('should verify calculateEmbeddings returns normalized embeddings', async () => {
    const testString = 'This is a test string for embedding verification'
    const calculateEmbeddingsResult = await calculateEmbeddings(testString)

    assert(
      Array.isArray(calculateEmbeddingsResult) || calculateEmbeddingsResult instanceof Float32Array,
      'calculateEmbeddings should return an array'
    )
    assert(
      calculateEmbeddingsResult.every(val => typeof val === 'number'),
      'calculateEmbeddings should return numeric values'
    )

    const hiddenSize = 384
    assert.strictEqual(calculateEmbeddingsResult.length, hiddenSize, 'calculateEmbeddings should return embedding of size 384')

    let norm = 0
    for (let i = 0; i < hiddenSize; i++) norm += calculateEmbeddingsResult[i] * calculateEmbeddingsResult[i]
    norm = Math.sqrt(norm)
    assert(Math.abs(norm - 1.0) < 0.001, `calculateEmbeddings should be normalized (norm ≈ 1.0), got ${norm}`)
  })

  test('should produce consistent embeddings for identical inputs', async () => {
    const testString = 'Consistent embedding test string'
    const embedding1 = await calculateEmbeddings(testString)
    const embedding2 = await calculateEmbeddings(testString)

    assert.strictEqual(embedding1.length, embedding2.length, 'Embeddings should have same length')
    for (let i = 0; i < embedding1.length; i++) {
      const diff = Math.abs(embedding1[i] - embedding2[i])
      assert(diff < 0.0001, `Embedding values should be consistent at index ${i}: ${embedding1[i]} vs ${embedding2[i]}`)
    }
  })

  test('should produce different embeddings for different inputs', async () => {
    const embedding1 = await calculateEmbeddings('First test string')
    const embedding2 = await calculateEmbeddings('Completely different sentence')

    assert.strictEqual(embedding1.length, embedding2.length, 'Embeddings should have same length')

    let dotProduct = 0, norm1 = 0, norm2 = 0
    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i]
      norm1 += embedding1[i] * embedding1[i]
      norm2 += embedding2[i] * embedding2[i]
    }
    const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2))
    assert(similarity < 0.99, `Different strings should produce different embeddings, similarity: ${similarity}`)
    assert(similarity > -1.0 && similarity < 1.0, `Similarity should be in valid range [-1, 1]: ${similarity}`)
  })

  test('should handle empty strings gracefully', async () => {
    try {
      const embedding = await calculateEmbeddings('')
      assert.strictEqual(embedding.length, 384, 'Empty string should still return 384-dimensional embedding')
      assert(
        embedding.every(val => typeof val === 'number' && isFinite(val)),
        'Empty string embedding should contain valid finite numbers'
      )
    } catch (error) {
      assert(error instanceof Error, 'Should throw a proper Error for empty strings')
    }
  })

  test('should handle reasonably long strings', async () => {
    const longString = 'This is a moderately long test string. '.repeat(10)
    const embedding = await calculateEmbeddings(longString)

    assert.strictEqual(embedding.length, 384, 'Long string should still return 384-dimensional embedding')

    let norm = 0
    for (let i = 0; i < embedding.length; i++) norm += embedding[i] * embedding[i]
    norm = Math.sqrt(norm)
    assert(Math.abs(norm - 1.0) < 0.001, `Long string embedding should be normalized: ${norm}`)
  })

  // createEmbeddings tests — fs writes are mocked; no tmp dirs created

  test('createEmbeddings preserves chunk order in output', async () => {
    const chunks = [
      'first chunk about cds init',
      'second chunk about cds watch',
      'third chunk about cds deploy',
      'fourth chunk about service definitions',
      'fifth chunk about entity projections'
    ]
    const writes = mockFsWrites()
    await createEmbeddings('test', chunks, '/mock-dir')
    const meta = getWrittenJson(writes)
    assert.deepStrictEqual(meta.chunks, chunks, 'output chunks must match input order exactly')
  })

  test('createEmbeddings writes metadata when provided', async () => {
    const chunks = ['chunk about cds init', 'chunk about cds watch', 'chunk about cds deploy']
    const metadata = [{ source: 'getting-started', label: 'node' }, { source: 'getting-started', label: 'java' }, { source: 'deploy', label: 'node' }]
    const writes = mockFsWrites()
    await createEmbeddings('test', chunks, '/mock-dir', { metadata })
    const meta = getWrittenJson(writes)
    assert.deepStrictEqual(meta.metadata, metadata, 'metadata must be written as-is')
    assert.deepStrictEqual(meta.chunks, chunks, 'chunks must still be present alongside metadata')
  })

  test('createEmbeddings without metadata produces no metadata key', async () => {
    const chunks = ['chunk about cds init']
    const writes = mockFsWrites()
    await createEmbeddings('test', chunks, '/mock-dir')
    const meta = getWrittenJson(writes)
    assert.strictEqual(meta.metadata, undefined, 'metadata key must be absent when not provided')
  })

  test('createEmbeddings places output under capire.version folder', async () => {
    const chunks = ['chunk about cds init']
    const capire = { commitId: '__commit_id_1234__', cdsDependency: { node: '>=10.0', java: '>=5.0' } }
    const writes = mockFsWrites()
    const { outDir } = await createEmbeddings('test', chunks, '/mock-dir', { capire })
    assert.ok(outDir.endsWith('__commit_id_1234__'), `outDir should end with version folder, got: ${outDir}`)
    const meta = getWrittenJson(writes)
    assert.deepStrictEqual(meta.capire, capire)
  })

  test('createEmbeddings without capire uses model folder only', async () => {
    const chunks = ['chunk about cds init']
    const writes = mockFsWrites()
    const { outDir, modelFolderName } = await createEmbeddings('test', chunks, '/mock-dir')
    const meta = getWrittenJson(writes)
    assert.strictEqual(meta.capire, undefined)
    assert.ok(outDir.endsWith(modelFolderName), `outDir should end with ${modelFolderName}, got: ${outDir}`)
  })

  test('createEmbeddings throws when metadata length mismatches chunks', async () => {
    await assert.rejects(
      () => createEmbeddings('test', ['a', 'b', 'c'], '/mock-dir', { metadata: [{ x: 1 }, { x: 2 }] }),
      /metadata length must match chunks length/
    )
  })

  test('calculateEmbeddings with explicit model returns different dimensions as default', async () => {
    const MODEL = 'nomic-ai/nomic-embed-text-v1.5'
    const text = 'test query for model param'
    const withoutModel = await calculateEmbeddings(text)
    const withModel = await calculateEmbeddings(text, MODEL)
    assert.notStrictEqual(withModel.length, withoutModel.length, 'explicit model must return different dim than default')
  })

  test('calculateEmbeddings reuses cache when called twice with same model', async () => {
    const MODEL = 'nomic-ai/nomic-embed-text-v1.5'
    const text = 'cache reuse test'
    await calculateEmbeddings(text, MODEL)
    const dbBefore = await getQueryDb(MODEL)
    dbBefore.cached = true
    await calculateEmbeddings(text, MODEL)
    const dbAfter = await getQueryDb(MODEL)
    assert.ok(dbAfter.cached, 'repeated call with same model must succeed')
  })

  test('calculateEmbeddings with undefined model falls back to default', async () => {
    const result = await calculateEmbeddings('no model param test', undefined)
    assert.strictEqual(result.length, 384, 'undefined model must use default and return 384-dim')
  })
})
