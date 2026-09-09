import { fileURLToPath } from 'url'
import { MODEL_FOLDER } from '../lib/calculateEmbeddings.js'
import path from 'path'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

import { test, describe } from 'node:test'
import assert from 'node:assert'
import fs from 'fs/promises'

const embeddingsDir = path.join(__dirname, '..', 'embeddings', MODEL_FOLDER)

// Use dynamic import to ensure environment variable is set before module evaluation
const searchModule = await import('../lib/searchMarkdownDocs.js')
const searchMarkdownDocs = searchModule.default
const { formatResult, getDocContext } = searchModule

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

describe('searchMarkdownDocs integration tests', () => {
  test('should download and load embeddings from server', async () => {
    // This test verifies the full download and search functionality
    const result = await searchMarkdownDocs('entity definition', 3)

    assert(typeof result === 'string', 'Result should be a string')
    assert(result.length > 0, 'Result should not be empty')
    assert(result.includes('---'), 'Result should contain separators between chunks')

    // Verify files were created
    const jsonExists = await fs
      .access(path.join(embeddingsDir, 'code-chunks.json'))
      .then(() => true)
      .catch(() => false)
    const binExists = await fs
      .access(path.join(embeddingsDir, 'code-chunks.bin'))
      .then(() => true)
      .catch(() => false)

    assert(jsonExists, 'JSON metadata file should exist after download')
    assert(binExists, 'Binary embeddings file should exist after download')
  })

  test('should handle search queries and return relevant results', async () => {
    const queries = ['entity definition', 'service implementation', 'authentication', 'database schema']

    for (const query of queries) {
      const result = await searchMarkdownDocs(query, 2)
      assert(typeof result === 'string', `Result for "${query}" should be a string`)
      assert(result.length > 0, `Result for "${query}" should not be empty`)

      const chunks = result.split('\n---\n')
      assert(chunks.length <= 2, `Should return at most 2 chunks for "${query}"`)
    }
  })

  test('should use embeddings files consistently', async () => {
    // Get file stats before making calls
    const jsonPath = path.join(embeddingsDir, 'code-chunks.json')
    const binPath = path.join(embeddingsDir, 'code-chunks.bin')

    // Ensure files exist first
    await searchMarkdownDocs('test', 1)

    const jsonStatBefore = await fs.stat(jsonPath)
    const binStatBefore = await fs.stat(binPath)

    // Make several calls
    const result1 = await searchMarkdownDocs('entity', 1)
    const result2 = await searchMarkdownDocs('service', 1)

    // Check that files weren't modified (using cached files)
    const jsonStatAfter = await fs.stat(jsonPath)
    const binStatAfter = await fs.stat(binPath)

    assert(typeof result1 === 'string', 'First result should be a string')
    assert(typeof result2 === 'string', 'Second result should be a string')
    assert(result1.length > 0, 'First result should not be empty')
    assert(result2.length > 0, 'Second result should not be empty')

    // Files should have same modification time (not re-downloaded)
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
  test('should reuse downloaded files on subsequent calls', async () => {
    // First call - downloads embeddings
    const result1 = await searchMarkdownDocs('entity', 1)

    // Verify files exist
    const jsonExists = await fs
      .access(path.join(embeddingsDir, 'code-chunks.json'))
      .then(() => true)
      .catch(() => false)
    const binExists = await fs
      .access(path.join(embeddingsDir, 'code-chunks.bin'))
      .then(() => true)
      .catch(() => false)

    assert(jsonExists, 'JSON file should exist')
    assert(binExists, 'Binary file should exist')

    // Second call - should use existing files
    const result2 = await searchMarkdownDocs('service', 1)
    assert(typeof result1 === 'string', 'First result should be a string')
    assert(typeof result2 === 'string', 'Second result should be a string')
    assert(result1.length > 0, 'First result should not be empty')
    assert(result2.length > 0, 'Second result should not be empty')
  })

  test('should respect maxResults parameter', async () => {
    const maxResults = 5
    const result = await searchMarkdownDocs('entity service', maxResults)

    const chunks = result.split('\n---\n')
    assert(chunks.length <= maxResults, `Should return at most ${maxResults} chunks`)

    // Test with different maxResults values
    for (const max of [1, 3, 10]) {
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
