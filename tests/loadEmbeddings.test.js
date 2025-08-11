import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadChunks } from '../lib/embeddings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEST_EMBEDDINGSDIR = path.join(__dirname, 'temp-embeddings')

describe('loadEmbeddings tests', () => {
  beforeEach(async () => {
    await fs.rm(TEST_EMBEDDINGSDIR, { recursive: true, force: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_EMBEDDINGSDIR, { recursive: true, force: true })
  })

  test('should handle missing embedding files', async () => {
    // Try to load chunks from non-existent directory
    await assert.rejects(loadChunks('nonexistent', TEST_EMBEDDINGSDIR), err => err.code === 'ENOENT')
  })

  test('should handle corrupted JSON metadata', async () => {
    await fs.mkdir(TEST_EMBEDDINGSDIR, { recursive: true })

    // Create corrupted JSON file
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.json'), 'invalid json content')
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.bin'), Buffer.from(new Float32Array([1, 2, 3, 4])))

    await assert.rejects(loadChunks('code', TEST_EMBEDDINGSDIR), err => err.code === 'EMBEDDINGS_CORRUPTED')

    // Verify corrupted files were cleaned up
    const jsonExists = await fs
      .access(path.join(TEST_EMBEDDINGSDIR, 'code.json'))
      .then(() => true)
      .catch(() => false)
    const binExists = await fs
      .access(path.join(TEST_EMBEDDINGSDIR, 'code.bin'))
      .then(() => true)
      .catch(() => false)
    assert.strictEqual(jsonExists, false)
    assert.strictEqual(binExists, false)
  })

  test('should handle malformed JSON structure', async () => {
    await fs.mkdir(TEST_EMBEDDINGSDIR, { recursive: true })

    // Create JSON with missing required fields
    const badMeta = { chunks: ['test'] } // Missing dim
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.json'), JSON.stringify(badMeta))
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.bin'), Buffer.from(new Float32Array([1, 2, 3, 4])))

    await assert.rejects(loadChunks('code', TEST_EMBEDDINGSDIR), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('should handle mismatched binary file size', async () => {
    await fs.mkdir(TEST_EMBEDDINGSDIR, { recursive: true })

    // Create metadata expecting 4 dimensions but binary has wrong size
    const meta = { dim: 4, count: 2, chunks: ['test1', 'test2'] }
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.json'), JSON.stringify(meta))

    // Binary should be 2 chunks * 4 dims * 4 bytes = 32 bytes, but provide less
    const wrongSizeBinary = new Float32Array([1, 2, 3]) // Only 12 bytes
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.bin'), Buffer.from(wrongSizeBinary.buffer))

    await assert.rejects(loadChunks('code', TEST_EMBEDDINGSDIR), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('should handle count mismatch in metadata', async () => {
    await fs.mkdir(TEST_EMBEDDINGSDIR, { recursive: true })

    // Create metadata with mismatched count
    const meta = { dim: 2, count: 5, chunks: ['test1', 'test2'] } // count != chunks.length
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.json'), JSON.stringify(meta))

    const binary = new Float32Array([1, 2, 3, 4]) // 2 chunks * 2 dims
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.bin'), Buffer.from(binary.buffer))

    await assert.rejects(loadChunks('code', TEST_EMBEDDINGSDIR), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('should handle NaN values in embeddings', async () => {
    await fs.mkdir(TEST_EMBEDDINGSDIR, { recursive: true })

    const meta = { dim: 2, count: 1, chunks: ['test'] }
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.json'), JSON.stringify(meta))

    // Create binary with NaN values
    const binary = new Float32Array([NaN, 2.0])
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.bin'), Buffer.from(binary.buffer))

    await assert.rejects(loadChunks('code', TEST_EMBEDDINGSDIR), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('should handle Infinity values in embeddings', async () => {
    await fs.mkdir(TEST_EMBEDDINGSDIR, { recursive: true })

    const meta = { dim: 2, count: 1, chunks: ['test'] }
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.json'), JSON.stringify(meta))

    // Create binary with Infinity values
    const binary = new Float32Array([Infinity, 2.0])
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.bin'), Buffer.from(binary.buffer))

    await assert.rejects(loadChunks('code', TEST_EMBEDDINGSDIR), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('should load valid embeddings correctly', async () => {
    await fs.mkdir(TEST_EMBEDDINGSDIR, { recursive: true })

    const chunks = ['Hello world', 'Test content']
    const meta = { dim: 3, count: 2, chunks }
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.json'), JSON.stringify(meta))

    // Create valid binary data
    const binary = new Float32Array([
      1.0,
      2.0,
      3.0, // First chunk embeddings
      4.0,
      5.0,
      6.0 // Second chunk embeddings
    ])
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.bin'), Buffer.from(binary.buffer))

    const result = await loadChunks('code', TEST_EMBEDDINGSDIR)

    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].content, 'Hello world')
    assert.strictEqual(result[1].content, 'Test content')

    // Check embeddings
    assert.deepStrictEqual(Array.from(result[0].embeddings), [1.0, 2.0, 3.0])
    assert.deepStrictEqual(Array.from(result[1].embeddings), [4.0, 5.0, 6.0])
  })

  test('should handle non-string chunk content', async () => {
    await fs.mkdir(TEST_EMBEDDINGSDIR, { recursive: true })

    const meta = { dim: 2, count: 1, chunks: [123] } // Non-string content
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.json'), JSON.stringify(meta))

    const binary = new Float32Array([1.0, 2.0])
    await fs.writeFile(path.join(TEST_EMBEDDINGSDIR, 'code.bin'), Buffer.from(binary.buffer))

    await assert.rejects(loadChunks('code', TEST_EMBEDDINGSDIR), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })
})
