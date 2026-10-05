import { test, describe, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { loadChunks } from '../lib/embeddings.js'
import { getActiveEmbeddingsDir, setEmbeddingsDir } from '../lib/calculateEmbeddings.js'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'loadEmbeddings-'))
setEmbeddingsDir(tmpDir)

after(async () => {
  setEmbeddingsDir()
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('loadChunks', () => {
  beforeEach(async () => {
    const dir = getActiveEmbeddingsDir()
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    await fsp.mkdir(dir, { recursive: true })
  })
  afterEach(() => mock.restoreAll())

  async function seedCode(json, bin) {
    const dir = getActiveEmbeddingsDir()
    await fsp.writeFile(path.join(dir, 'code.json'), typeof json === 'string' ? json : JSON.stringify(json))
    await fsp.writeFile(path.join(dir, 'code.bin'), Buffer.from(bin.buffer))
  }

  test('throws ENOENT when embedding files are missing', async () => {
    // empty dir → read rejects ENOENT
    await assert.rejects(loadChunks('nonexistent'), err => err.code === 'ENOENT')
  })

  test('throws EMBEDDINGS_CORRUPTED and deletes both files when JSON is invalid', async () => {
    await seedCode('invalid json content', new Float32Array([1, 2, 3, 4]))

    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')

    const dir = getActiveEmbeddingsDir()
    const jsonGone = await fsp.access(path.join(dir, 'code.json')).then(() => false, () => true)
    const binGone = await fsp.access(path.join(dir, 'code.bin')).then(() => false, () => true)
    assert.ok(jsonGone, 'json file must be deleted on CORRUPTED')
    assert.ok(binGone, 'bin file must be deleted on CORRUPTED')
  })

  test('throws EMBEDDINGS_CORRUPTED when JSON is valid but missing dim field', async () => {
    await seedCode({ chunks: ['test'] }, new Float32Array([1, 2, 3, 4])) // missing dim
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('throws EMBEDDINGS_CORRUPTED when binary size does not match dim × count', async () => {
    await seedCode({ dim: 4, count: 2, chunks: ['test1', 'test2'] }, new Float32Array([1, 2, 3])) // 12 bytes, needs 32
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('throws EMBEDDINGS_CORRUPTED when chunk count mismatches metadata count', async () => {
    await seedCode({ dim: 2, count: 5, chunks: ['test1', 'test2'] }, new Float32Array([1, 2, 3, 4]))
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('throws EMBEDDINGS_CORRUPTED when embedding vector contains NaN', async () => {
    await seedCode({ dim: 2, count: 1, chunks: ['test'] }, new Float32Array([NaN, 2.0]))
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('throws EMBEDDINGS_CORRUPTED when embedding vector contains Infinity', async () => {
    await seedCode({ dim: 2, count: 1, chunks: ['test'] }, new Float32Array([Infinity, 2.0]))
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('returns chunks with correct content and sliced float32 vectors', async () => {
    const chunks = ['Hello world', 'Test content']
    await seedCode({ dim: 3, count: 2, chunks }, new Float32Array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]))

    const result = await loadChunks('code')

    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].content, 'Hello world')
    assert.strictEqual(result[1].content, 'Test content')
    assert.deepStrictEqual(Array.from(result[0].embeddings), [1.0, 2.0, 3.0])
    assert.deepStrictEqual(Array.from(result[1].embeddings), [4.0, 5.0, 6.0])
  })

  test('throws EMBEDDINGS_CORRUPTED when chunk content is not a string', async () => {
    await seedCode({ dim: 2, count: 1, chunks: [123] }, new Float32Array([1.0, 2.0]))
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })

  test('loads parallel metadata[] matched by index', async () => {
    await seedCode(
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
    await seedCode({ dim: 2, count: 2, chunks: ['a', 'b'] }, new Float32Array([1, 2, 3, 4]))

    const result = await loadChunks('code')
    assert.strictEqual(result[0].content, 'a')
    assert.strictEqual('meta' in result[0], false)
    assert.strictEqual('meta' in result[1], false)
  })

  test('metadata[] with wrong length is treated as corrupted', async () => {
    await seedCode({ dim: 2, count: 2, chunks: ['a', 'b'], metadata: [{ source: 'a.md' }] }, new Float32Array([1, 2, 3, 4]))
    await assert.rejects(loadChunks('code'), err => err.code === 'EMBEDDINGS_CORRUPTED')
  })
})
