import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { installMemFs } from './helpers/mem-fs-mock.js'
import { loadChunks } from '../lib/embeddings.js'
import { getActiveEmbeddingsDir } from '../lib/calculateEmbeddings.js'

describe('loadChunks', () => {
  let mem
  beforeEach(() => {
    mem = installMemFs()
  })
  afterEach(() => mock.restoreAll())

  // Seed the in-memory `code.json` / `code.bin` that loadChunks('code') reads.
  function seedCode(json, bin) {
    const dir = getActiveEmbeddingsDir()
    mem.seedFile(path.join(dir, 'code.json'), typeof json === 'string' ? json : JSON.stringify(json))
    mem.seedFile(path.join(dir, 'code.bin'), Buffer.from(bin.buffer))
  }

  test('throws ENOENT when embedding files are missing', async () => {
    // empty store → read rejects ENOENT
    await assert.rejects(loadChunks('nonexistent'), err => err.code === 'ENOENT')
  })

  test('throws EMBEDDINGS_CORRUPTED and deletes both files when JSON is invalid', async () => {
    seedCode('invalid json content', new Float32Array([1, 2, 3, 4]))

    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')

    const paths = mem.mocks.unlink.mock.calls.map(c => String(c.arguments[0]))
    assert.ok(
      paths.some(p => p.endsWith('.json')),
      'json file must be unlinked'
    )
    assert.ok(
      paths.some(p => p.endsWith('.bin')),
      'bin file must be unlinked'
    )
  })

  test('throws EMBEDDINGS_CORRUPTED when JSON is valid but missing dim field', async () => {
    seedCode({ chunks: ['test'] }, new Float32Array([1, 2, 3, 4])) // missing dim
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('throws EMBEDDINGS_CORRUPTED when binary size does not match dim × count', async () => {
    seedCode({ dim: 4, count: 2, chunks: ['test1', 'test2'] }, new Float32Array([1, 2, 3])) // 12 bytes, needs 32
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('throws EMBEDDINGS_CORRUPTED when chunk count mismatches metadata count', async () => {
    seedCode({ dim: 2, count: 5, chunks: ['test1', 'test2'] }, new Float32Array([1, 2, 3, 4]))
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('throws EMBEDDINGS_CORRUPTED when embedding vector contains NaN', async () => {
    seedCode({ dim: 2, count: 1, chunks: ['test'] }, new Float32Array([NaN, 2.0]))
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('throws EMBEDDINGS_CORRUPTED when embedding vector contains Infinity', async () => {
    seedCode({ dim: 2, count: 1, chunks: ['test'] }, new Float32Array([Infinity, 2.0]))
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('returns chunks with correct content and sliced float32 vectors', async () => {
    const chunks = ['Hello world', 'Test content']
    seedCode({ dim: 3, count: 2, chunks }, new Float32Array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]))

    const result = await loadChunks('code')

    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].content, 'Hello world')
    assert.strictEqual(result[1].content, 'Test content')
    assert.deepStrictEqual(Array.from(result[0].embeddings), [1.0, 2.0, 3.0])
    assert.deepStrictEqual(Array.from(result[1].embeddings), [4.0, 5.0, 6.0])
  })

  test('throws EMBEDDINGS_CORRUPTED when chunk content is not a string', async () => {
    seedCode({ dim: 2, count: 1, chunks: [123] }, new Float32Array([1.0, 2.0]))
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('loads parallel metadata[] matched by index', async () => {
    seedCode(
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
    assert.deepStrictEqual(result[0].meta, {
      source: 'a.md',
      breadcrumb: 'Root > A'
    })
    assert.strictEqual(result[1].content, 'Test content')
    assert.deepStrictEqual(result[1].meta, { source: 'b.md' })
  })

  test('files without metadata[] load unchanged (backward compat)', async () => {
    seedCode({ dim: 2, count: 2, chunks: ['a', 'b'] }, new Float32Array([1, 2, 3, 4]))

    const result = await loadChunks('code')
    assert.strictEqual(result[0].content, 'a')
    assert.strictEqual('meta' in result[0], false)
    assert.strictEqual('meta' in result[1], false)
  })

  test('metadata[] with wrong length is treated as corrupted', async () => {
    seedCode({ dim: 2, count: 2, chunks: ['a', 'b'], metadata: [{ source: 'a.md' }] }, new Float32Array([1, 2, 3, 4]))
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })
})
