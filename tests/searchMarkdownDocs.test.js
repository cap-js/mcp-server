import { fileURLToPath } from 'url'
import { getActiveModel, toDirName } from '../lib/calculateEmbeddings.js'
import path from 'path'
import fs from 'fs/promises'
import { test, describe, after } from 'node:test'
import assert from 'node:assert'
import { buildTestBundle, makeFetchStub, getManifestEtagPath, TEST_COMMIT_ID } from './helpers/testBundle.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const embeddingsDir = path.join(__dirname, '..', 'embeddings', toDirName(getActiveModel()))
const testBundleDir = path.join(embeddingsDir, TEST_COMMIT_ID)
const manifestEtagPath = getManifestEtagPath()

// Save etag that may exist before we overwrite it with the test bundle etag.
const savedEtag = await fs.readFile(manifestEtagPath, 'utf-8').catch(() => null)

// Build real embeddings and mock fetch BEFORE importing searchMarkdownDocs.js.
// That module fires downloadEmbeddings() at module load time — mock must be in place first.
const testFrame = await buildTestBundle()
globalThis.fetch = makeFetchStub(testFrame)

const searchModule = await import('../lib/searchMarkdownDocs.js')
const searchMarkdownDocs = searchModule.default
const { formatResult, getDocContext } = searchModule

after(async () => {
  globalThis.fetch = undefined
  await fs.rm(testBundleDir, { recursive: true, force: true }).catch(() => {})
  if (savedEtag !== null) {
    await fs.mkdir(path.dirname(manifestEtagPath), { recursive: true })
    await fs.writeFile(manifestEtagPath, savedEtag)
  } else {
    await fs.rm(path.dirname(manifestEtagPath), { recursive: true, force: true }).catch(() => {})
  }
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

describe('searchMarkdownDocs integration tests', () => {
  test('should download and load embeddings from server', async () => {
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

  test('should reuse downloaded files on subsequent calls', async () => {
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

  test('should respect maxResults parameter', async () => {
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
