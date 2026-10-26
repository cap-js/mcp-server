import { getActiveEmbeddingsDir, setEmbeddingsDir } from '../lib/calculateEmbeddings.js'
import path from 'path'
import fs from 'fs/promises'
import { test, describe, before, beforeEach, after, mock } from 'node:test'
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
    headers: {
      etag: `W/"${version}"`,
      'x-embeddings-version': version,
      'content-type': 'application/octet-stream'
    }
  })
})

const searchModule = await import('../lib/searchMarkdownDocs.js')
const searchMarkdownDocs = searchModule.default
const { formatResult, dedupByContent } = searchModule

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

describe('dedupByContent', () => {
  const make = (content, id = content) => ({ content, id })

  test('returns all items when they are unique and count is below limit', () => {
    const items = [make('a'), make('b'), make('c')]
    assert.deepStrictEqual(dedupByContent(items, 5), items)
  })

  test('stops at exactly the limit', () => {
    const items = [make('a'), make('b'), make('c'), make('d')]
    const result = dedupByContent(items, 2)
    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].content, 'a')
    assert.strictEqual(result[1].content, 'b')
  })

  test('removes duplicate content, keeping first occurrence', () => {
    const first = make('x', 'first')
    const dup = make('x', 'second')
    const other = make('y', 'other')
    const result = dedupByContent([first, dup, other], 10)
    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].id, 'first')
    assert.strictEqual(result[1].content, 'y')
  })

  test('limit is applied after deduplication', () => {
    // 4 items where two are duplicates; effective unique count is 3 — limit 2 should yield 2
    const items = [make('a'), make('b'), make('a'), make('c')]
    const result = dedupByContent(items, 2)
    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].content, 'a')
    assert.strictEqual(result[1].content, 'b')
  })

  test('returns empty array for empty input', () => {
    assert.deepStrictEqual(dedupByContent([], 5), [])
  })

  test('does not break when limit exceeds unique item count', () => {
    const items = [make('a'), make('b')]
    assert.strictEqual(dedupByContent(items, 100).length, 2)
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
    const queries = [
      'entity definition',
      'service implementation',
      'authentication',
      'database schema'
    ]

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

  test('returns exactly maxResults chunks when the bundle has enough unique content', async () => {
    // The test bundle has 9 unique chunks after deduplication, so requesting
    // any N < 9 must yield exactly N — not "at most N".
    for (const n of [1, 3, 5]) {
      const result = await searchMarkdownDocs('cds entity service project', n)
      const chunks = result.split('\n---\n')
      assert.strictEqual(chunks.length, n, `Expected exactly ${n} chunk(s), got ${chunks.length}`)
    }
  })

  describe('deduplication', () => {
    const DUPLICATE_TEXT = 'Register custom event handlers to add business logic to a CAP service.'

    describe('when the bundle contains two chunks with identical content', () => {
      test('should return only one section', async () => {
        const result = await searchMarkdownDocs(DUPLICATE_TEXT, 5)
        const sections = result.split('\n---\n')

        const dupSections = sections.filter((s) => s.includes(DUPLICATE_TEXT))
        assert.strictEqual(
          dupSections.length,
          1,
          'both copies of the duplicate text must not both appear'
        )
      })

      test('should keep the highest-ranked entry (label: node, not label: java)', async () => {
        const result = await searchMarkdownDocs(DUPLICATE_TEXT, 5)
        const sections = result.split('\n---\n')

        const dupSection = sections.find((s) => s.includes(DUPLICATE_TEXT))
        assert(dupSection, 'at least one section must contain the duplicate text')
        assert(
          dupSection.includes('label: node'),
          'the surviving section must be the higher-ranked node entry'
        )
        assert(!dupSection.includes('label: java'), 'the lower-ranked java entry must not appear')
      })

      test('should not exceed maxResults', async () => {
        const result = await searchMarkdownDocs(DUPLICATE_TEXT, 3)
        const sections = result.split('\n---\n')

        assert(sections.length <= 3, `must return at most 3 chunks, got ${sections.length}`)
      })
    })

    describe('when all chunks are unique', () => {
      test('should pass all chunks through unchanged', async () => {
        const result = await searchMarkdownDocs('cds init', 5)
        const sections = result.split('\n---\n')

        const uniqueContents = new Set(sections)
        assert.strictEqual(
          uniqueContents.size,
          sections.length,
          'all returned sections must have distinct content'
        )
      })
    })

    describe('when duplicate chunks have no runtime label', () => {
      test('should return only one section', async () => {
        const NO_LABEL_TEXT = 'Provide localized texts for your model using i18n properties files.'

        const result = await searchMarkdownDocs(NO_LABEL_TEXT, 5)
        const sections = result.split('\n---\n')

        const dupSections = sections.filter((s) => s.includes(NO_LABEL_TEXT))
        assert.strictEqual(dupSections.length, 1, 'both label-free copies must not both appear')
      })
    })
  })

  describe('CDS_MCP_MAX_RESULTS env var', () => {
    let _prev
    before(() => {
      _prev = process.env.CDS_MCP_MAX_RESULTS
    })
    beforeEach(() => {
      delete process.env.CDS_MCP_MAX_RESULTS
    })
    after(() => {
      if (_prev === undefined) delete process.env.CDS_MCP_MAX_RESULTS
      else process.env.CDS_MCP_MAX_RESULTS = _prev
    })

    test('overrides the maxResults argument', async () => {
      const uncapped = await searchMarkdownDocs('entity service', 10)
      const uncappedChunks = uncapped.split('\n---\n')
      assert(uncappedChunks.length > 1, 'Precondition: query must return >1 chunk without a cap')

      process.env.CDS_MCP_MAX_RESULTS = '1'
      const result = await searchMarkdownDocs('entity service', 10)
      const chunks = result.split('\n---\n')
      assert.strictEqual(
        chunks.length,
        1,
        'CDS_MCP_MAX_RESULTS=1 should cap results to exactly 1 for this multi-result query'
      )
    })

    test('overrides the default maxResults', async () => {
      process.env.CDS_MCP_MAX_RESULTS = '2'
      const result = await searchMarkdownDocs('entity service')
      const chunks = result.split('\n---\n')
      assert(
        chunks.length <= 2,
        'CDS_MCP_MAX_RESULTS=2 should cap results to 2 when no argument is given'
      )
    })

    test('does not inflate a smaller caller request', async () => {
      process.env.CDS_MCP_MAX_RESULTS = '10'
      const result = await searchMarkdownDocs('entity service', 1)
      const chunks = result.split('\n---\n')
      assert(
        chunks.length <= 1,
        'CDS_MCP_MAX_RESULTS=10 must not inflate a caller request of maxResults=1'
      )
    })

    test('throws on non-integer value', async () => {
      process.env.CDS_MCP_MAX_RESULTS = 'abc'
      await assert.rejects(
        () => searchMarkdownDocs('entity'),
        /CDS_MCP_MAX_RESULTS must be a positive integer/
      )
    })

    test('throws on zero', async () => {
      process.env.CDS_MCP_MAX_RESULTS = '0'
      await assert.rejects(
        () => searchMarkdownDocs('entity'),
        /CDS_MCP_MAX_RESULTS must be a positive integer/
      )
    })
  })
})
