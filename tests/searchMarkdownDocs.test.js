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
const { formatResult } = searchModule

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

  test('CDS_MCP_MAX_RESULTS overrides the maxResults argument', async () => {
    const prev = process.env.CDS_MCP_MAX_RESULTS
    delete process.env.CDS_MCP_MAX_RESULTS
    try {
      // Verify the query naturally returns more than 1 chunk so the cap is meaningful.
      const uncapped = await searchMarkdownDocs('entity service', 10)
      const uncappedChunks = uncapped.split('\n---\n')
      assert(uncappedChunks.length > 1, 'Precondition: query must return >1 chunk without a cap')

      process.env.CDS_MCP_MAX_RESULTS = '1'
      const result = await searchMarkdownDocs('entity service', 10)
      const chunks = result.split('\n---\n')
      assert.strictEqual(chunks.length, 1, 'CDS_MCP_MAX_RESULTS=1 should cap results to exactly 1 for this multi-result query')
    } finally {
      if (prev === undefined) delete process.env.CDS_MCP_MAX_RESULTS
      else process.env.CDS_MCP_MAX_RESULTS = prev
    }
  })

  test('CDS_MCP_MAX_RESULTS overrides the default maxResults', async () => {
    const prev = process.env.CDS_MCP_MAX_RESULTS
    try {
      process.env.CDS_MCP_MAX_RESULTS = '2'
      const result = await searchMarkdownDocs('entity service')
      const chunks = result.split('\n---\n')
      assert(chunks.length <= 2, 'CDS_MCP_MAX_RESULTS=2 should cap results to 2 when no argument is given')
    } finally {
      if (prev === undefined) delete process.env.CDS_MCP_MAX_RESULTS
      else process.env.CDS_MCP_MAX_RESULTS = prev
    }
  })

  test('CDS_MCP_MAX_RESULTS does not inflate a smaller caller request', async () => {
    const prev = process.env.CDS_MCP_MAX_RESULTS
    try {
      process.env.CDS_MCP_MAX_RESULTS = '10'
      const result = await searchMarkdownDocs('entity service', 1)
      const chunks = result.split('\n---\n')
      assert(chunks.length <= 1, 'CDS_MCP_MAX_RESULTS=10 must not inflate a caller request of maxResults=1')
    } finally {
      if (prev === undefined) delete process.env.CDS_MCP_MAX_RESULTS
      else process.env.CDS_MCP_MAX_RESULTS = prev
    }
  })

  test('CDS_MCP_MAX_RESULTS throws on non-integer value', async () => {
    const prev = process.env.CDS_MCP_MAX_RESULTS
    try {
      process.env.CDS_MCP_MAX_RESULTS = 'abc'
      await assert.rejects(
        () => searchMarkdownDocs('entity'),
        /CDS_MCP_MAX_RESULTS must be a positive integer/
      )
    } finally {
      if (prev === undefined) delete process.env.CDS_MCP_MAX_RESULTS
      else process.env.CDS_MCP_MAX_RESULTS = prev
    }
  })

  test('CDS_MCP_MAX_RESULTS throws on zero', async () => {
    const prev = process.env.CDS_MCP_MAX_RESULTS
    try {
      process.env.CDS_MCP_MAX_RESULTS = '0'
      await assert.rejects(
        () => searchMarkdownDocs('entity'),
        /CDS_MCP_MAX_RESULTS must be a positive integer/
      )
    } finally {
      if (prev === undefined) delete process.env.CDS_MCP_MAX_RESULTS
      else process.env.CDS_MCP_MAX_RESULTS = prev
    }
  })
})
