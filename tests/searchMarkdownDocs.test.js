import { getActiveEmbeddingsDir, setEmbeddingsDir } from '../lib/calculateEmbeddings.js'
import path from 'path'
import fs from 'fs/promises'
import { test, describe, after, mock } from 'node:test'
import assert from 'node:assert'
import os from 'node:os'
import { buildTestBundle } from './helpers/test-bundle.js'
const TEST_COMMIT_ID = '__test_bundle__'

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'searchMarkdownDocs-'))
setEmbeddingsDir(tmpDir)

const embeddingsDir = getActiveEmbeddingsDir()
const testBundleDir = path.join(embeddingsDir, TEST_COMMIT_ID)

// Install the test bundle in-process BEFORE importing searchMarkdownDocs.js.
let _frame = null
mock.method(globalThis, 'fetch', async () => {
  if (!_frame) _frame = buildTestBundle()
  const f = await _frame
  const version = '__test_bundle__'
  return new Response(f, {
    status: 200,
    headers: { etag: `W/"${version}"`, 'x-embeddings-version': version, 'content-type': 'application/octet-stream' }
  })
})

const searchModule = await import('../lib/searchMarkdownDocs.js')
const searchMarkdownDocs = searchModule.default
const { formatResult, getDocContext } = searchModule

after(async () => {
  mock.restoreAll()
  setEmbeddingsDir()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('formatResult', () => {
  test('returns content unchanged when meta is absent', () => {
    assert.strictEqual(formatResult({ content: 'body' }), 'body')
  })

  test('backward compat: `meta` explicitly undefined behaves like missing key', () => {
    assert.strictEqual(formatResult({ content: 'body', meta: undefined }), 'body')
  })

  test('backward compat: joined output for meta-less results is unchanged', () => {
    // Simulates what searchMarkdownDocs does with pre-metadata files.
    const results = [{ content: 'A' }, { content: 'B' }, { content: 'C' }]
    const joined = results.map(formatResult).join('\n---\n')
    assert.strictEqual(joined, 'A\n---\nB\n---\nC')
  })

  test('prepends meta as key: value lines separated by blank line', () => {
    const out = formatResult({
      content: 'body text',
      meta: { source: 'a.md', breadcrumb: 'Root > A' }
    })
    assert.strictEqual(out, 'source: a.md\nbreadcrumb: Root > A\n\nbody text')
  })

  test('skips null/undefined/empty meta values', () => {
    const out = formatResult({
      content: 'body',
      meta: { source: 'a.md', breadcrumb: null, tag: '', depth: undefined }
    })
    assert.strictEqual(out, 'source: a.md\n\nbody')
  })

  test('returns content only when all meta values are empty', () => {
    assert.strictEqual(formatResult({ content: 'body', meta: {} }), 'body')
    assert.strictEqual(formatResult({ content: 'body', meta: { x: null } }), 'body')
  })
})

describe('searchMarkdownDocs', () => {
  test('downloads bundle, writes .json and .bin files, and returns non-empty --- separated string', async () => {
    const result = await searchMarkdownDocs('entity definition', 3)

    assert(typeof result === 'string', 'Result should be a string')
    assert(result.length > 0, 'Result should not be empty')
    assert(result.includes('---'), 'Result should contain separators between chunks')

    const jsonExists = await fs
      .access(path.join(testBundleDir, 'code-chunks.json'))
      .then(() => true)
      .catch(() => false)
    const binExists = await fs
      .access(path.join(testBundleDir, 'code-chunks.bin'))
      .then(() => true)
      .catch(() => false)

    assert(jsonExists, 'JSON metadata file should exist after download')
    assert(binExists, 'Binary embeddings file should exist after download')
  })

  test('returns at most maxResults chunks for multiple distinct queries', async () => {
    const queries = ['entity definition', 'service implementation', 'authentication', 'database schema']

    for (const query of queries) {
      const result = await searchMarkdownDocs(query, 2)
      assert(typeof result === 'string', `Result for "${query}" should be a string`)
      assert(result.length > 0, `Result for "${query}" should not be empty`)

      const chunks = result.split('\n---\n')
      assert(chunks.length <= 2, `Should return at most 2 chunks for "${query}"`)
    }
  })

  test('embedding files are not re-written on subsequent search calls', async () => {
    const jsonPath = path.join(testBundleDir, 'code-chunks.json')
    const binPath = path.join(testBundleDir, 'code-chunks.bin')

    // Files already written by the initial download; this call just uses them.
    await searchMarkdownDocs('test', 1)

    const jsonStatBefore = await fs.stat(jsonPath)
    const binStatBefore = await fs.stat(binPath)

    const result1 = await searchMarkdownDocs('entity', 1)
    const result2 = await searchMarkdownDocs('service', 1)

    const jsonStatAfter = await fs.stat(jsonPath)
    const binStatAfter = await fs.stat(binPath)

    assert(typeof result1 === 'string', 'First result should be a string')
    assert(typeof result2 === 'string', 'Second result should be a string')
    assert(result1.length > 0, 'First result should not be empty')
    assert(result2.length > 0, 'Second result should not be empty')

    assert.strictEqual(
      jsonStatBefore.mtime.getTime(),
      jsonStatAfter.mtime.getTime(),
      'JSON file should not be re-downloaded'
    )
    assert.strictEqual(
      binStatBefore.mtime.getTime(),
      binStatAfter.mtime.getTime(),
      'Binary file should not be re-downloaded'
    )
  })

  test('reuses cached embedding files on subsequent calls', async () => {
    const result1 = await searchMarkdownDocs('entity', 1)

    const jsonExists = await fs
      .access(path.join(testBundleDir, 'code-chunks.json'))
      .then(() => true)
      .catch(() => false)
    const binExists = await fs
      .access(path.join(testBundleDir, 'code-chunks.bin'))
      .then(() => true)
      .catch(() => false)

    assert(jsonExists, 'JSON file should exist')
    assert(binExists, 'Binary file should exist')

    const result2 = await searchMarkdownDocs('service', 1)
    assert(typeof result1 === 'string', 'First result should be a string')
    assert(typeof result2 === 'string', 'Second result should be a string')
    assert(result1.length > 0, 'First result should not be empty')
    assert(result2.length > 0, 'Second result should not be empty')
  })

  test('LOCAL_EMBEDDINGS_DIR env var is ignored', async () => {
    const prev = process.env.LOCAL_EMBEDDINGS_DIR
    try {
      process.env.LOCAL_EMBEDDINGS_DIR = '/nonexistent/path/that/does/not/exist'
      const result = await searchMarkdownDocs('entity', 1)
      assert(typeof result === 'string', 'Result should be a string')
      assert(result.length > 0, 'Result should not be empty')
    } finally {
      if (prev === undefined) delete process.env.LOCAL_EMBEDDINGS_DIR
      else process.env.LOCAL_EMBEDDINGS_DIR = prev
    }
  })

  test('respects maxResults and returns at most N chunks for varying limits', async () => {
    const maxResults = 5
    const result = await searchMarkdownDocs('entity service', maxResults)

    const chunks = result.split('\n---\n')
    assert(chunks.length <= maxResults, `Should return at most ${maxResults} chunks`)

    for (const max of [1, 3, 6]) {
      const limitedResult = await searchMarkdownDocs('cds model', max)
      const limitedChunks = limitedResult.split('\n---\n')
      assert(limitedChunks.length <= max, `Should return at most ${max} chunks`)
    }
  })
})

describe('getDocContext integration tests', () => {
  test('after: returns neighbor chunks that differ from anchor', async () => {
    const seed = await searchMarkdownDocs('entity definition', 1)
    assert(seed.length > 0, 'seed search must produce a chunk')

    const after = await getDocContext(seed, 'after', 2)
    assert.strictEqual(typeof after, 'string')
    assert(after.length > 0, 'after result should not be empty')
    const parts = after.split('\n---\n')
    assert(parts.length <= 2, 'at most 2 neighbors for count=2')
    for (const p of parts) {
      assert.notStrictEqual(p, seed, 'neighbor must not equal anchor')
    }
  })

  test('before: returns chunks before anchor', async () => {
    const seed = await searchMarkdownDocs('service implementation', 1)
    const before = await getDocContext(seed, 'before', 1)
    assert.strictEqual(typeof before, 'string')
    // may be empty if anchor is chunk 0 — assert only shape
    if (before.length > 0) {
      assert.notStrictEqual(before, seed)
    }
  })

  test('both: up to 2*count neighbors, none equal anchor', async () => {
    const seed = await searchMarkdownDocs('database schema', 1)
    const both = await getDocContext(seed, 'both', 2)
    const parts = both.split('\n---\n').filter(Boolean)
    assert(parts.length <= 4, 'at most 4 for count=2 both directions')
    for (const p of parts) assert.notStrictEqual(p, seed)
  })

  test('count=0 returns empty string', async () => {
    const seed = await searchMarkdownDocs('entity', 1)
    const out = await getDocContext(seed, 'both', 0)
    assert.strictEqual(out, '')
  })

  test('validates inputs', async () => {
    await assert.rejects(() => getDocContext('', 'after', 1), /non-empty/)
    await assert.rejects(() => getDocContext('x', 'sideways', 1), /direction/)
    await assert.rejects(() => getDocContext('x', 'after', -1), /count/)
    await assert.rejects(() => getDocContext('x', 'after', 1.5), /count/)
  })

  test('slightly modified chunk still matches same anchor', async () => {
    const seed = await searchMarkdownDocs('authentication', 1)
    const clean = await getDocContext(seed, 'after', 2)
    const noisy = await getDocContext(seed + '\n\nextra trailing whitespace', 'after', 2)
    assert.strictEqual(clean, noisy, 'cosine match should be tolerant to trivial edits')
  })
})
