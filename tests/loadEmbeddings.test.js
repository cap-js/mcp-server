import { test, describe, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { mockReadFile, mockUnlink } from './helpers/mock-fs.js'
import { loadChunks } from '../lib/embeddings.js'

describe('loadEmbeddings tests', () => {
  afterEach(() => mock.restoreAll())

  test('should handle missing embedding files', async () => {
    await assert.rejects(loadChunks('nonexistent'), err => err.code === 'ENOENT')
  })

  test('should handle corrupted JSON metadata', async () => {
    mockReadFile('invalid json content', new Float32Array([1, 2, 3, 4]))
    const unlinkMock = mockUnlink()

    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')

    const paths = unlinkMock.mock.calls.map(c => String(c.arguments[0]))
    assert.ok(paths.some(p => p.endsWith('.json')), 'json file must be unlinked')
    assert.ok(paths.some(p => p.endsWith('.bin')), 'bin file must be unlinked')
  })

  test('should handle malformed JSON structure', async () => {
    mockReadFile({ chunks: ['test'] }, new Float32Array([1, 2, 3, 4])) // missing dim
    mockUnlink()
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('should handle mismatched binary file size', async () => {
    mockReadFile({ dim: 4, count: 2, chunks: ['test1', 'test2'] }, new Float32Array([1, 2, 3])) // 12 bytes, needs 32
    mockUnlink()
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('should handle count mismatch in metadata', async () => {
    mockReadFile({ dim: 2, count: 5, chunks: ['test1', 'test2'] }, new Float32Array([1, 2, 3, 4]))
    mockUnlink()
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('should handle NaN values in embeddings', async () => {
    mockReadFile({ dim: 2, count: 1, chunks: ['test'] }, new Float32Array([NaN, 2.0]))
    mockUnlink()
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('should handle Infinity values in embeddings', async () => {
    mockReadFile({ dim: 2, count: 1, chunks: ['test'] }, new Float32Array([Infinity, 2.0]))
    mockUnlink()
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('should load valid embeddings correctly', async () => {
    const chunks = ['Hello world', 'Test content']
    mockReadFile({ dim: 3, count: 2, chunks }, new Float32Array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]))

    const result = await loadChunks('code')

    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].content, 'Hello world')
    assert.strictEqual(result[1].content, 'Test content')
    assert.deepStrictEqual(Array.from(result[0].embeddings), [1.0, 2.0, 3.0])
    assert.deepStrictEqual(Array.from(result[1].embeddings), [4.0, 5.0, 6.0])
  })

  test('should handle non-string chunk content', async () => {
    mockReadFile({ dim: 2, count: 1, chunks: [123] }, new Float32Array([1.0, 2.0]))
    mockUnlink()
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('loads parallel metadata[] matched by index', async () => {
    mockReadFile(
      {
        dim: 3,
        count: 2,
        chunks: ['Hello world', 'Test content'],
        metadata: [{ source: 'a.md', breadcrumb: 'Root > A' }, { source: 'b.md' }]
      },
      new Float32Array([1, 2, 3, 4, 5, 6])
    )

    const result = await loadChunks('code')
    assert.strictEqual(result[0].content, 'Hello world')
    assert.deepStrictEqual(result[0].meta, { source: 'a.md', breadcrumb: 'Root > A' })
    assert.strictEqual(result[1].content, 'Test content')
    assert.deepStrictEqual(result[1].meta, { source: 'b.md' })
  })

  test('files without metadata[] load unchanged (backward compat)', async () => {
    mockReadFile({ dim: 2, count: 2, chunks: ['a', 'b'] }, new Float32Array([1, 2, 3, 4]))

    const result = await loadChunks('code')
    assert.strictEqual(result[0].content, 'a')
    assert.strictEqual('meta' in result[0], false)
    assert.strictEqual('meta' in result[1], false)
  })

  test('metadata[] with wrong length is treated as corrupted', async () => {
    mockReadFile(
      { dim: 2, count: 2, chunks: ['a', 'b'], metadata: [{ source: 'a.md' }] },
      new Float32Array([1, 2, 3, 4])
    )
    mockUnlink()
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })
})
