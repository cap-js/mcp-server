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
const { formatResult, joinSectionParts, selectCompleteSections } = searchModule

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

// ─── joinSectionParts ─────────────────────────────────────────────────────────

describe('joinSectionParts', () => {
  test('returns content unchanged when there is one part', () => {
    assert.strictEqual(joinSectionParts(['### Title\n\nBody.']), '### Title\n\nBody.')
  })

  test('two parts with repeated heading: title once, both bodies joined by blank line', () => {
    const result = joinSectionParts(['### Title\n\nFirst.', '### Title\n\nSecond.'])
    assert.strictEqual(result, '### Title\n\nFirst.\n\nSecond.')
    const count = (result.match(/### Title/g) || []).length
    assert.strictEqual(count, 1, 'title must appear exactly once')
  })

  test('three or more parts: all joined, title once', () => {
    const result = joinSectionParts([
      '### Title\n\nPart 1.',
      '### Title\n\nPart 2.',
      '### Title\n\nPart 3.',
    ])
    assert(result.includes('Part 1.'))
    assert(result.includes('Part 2.'))
    assert(result.includes('Part 3.'))
    assert.strictEqual((result.match(/### Title/g) || []).length, 1)
  })

  test('later part that does not start with the title is kept whole', () => {
    const result = joinSectionParts(['### Title\n\nFirst.', 'Different heading.\n\nSecond.'])
    assert(result.includes('Different heading.'), 'different heading must not be stripped')
  })

  test('first line is not a heading: nothing is stripped from later parts', () => {
    const result = joinSectionParts(['No heading here.\n\nFirst.', 'No heading here.\n\nSecond.'])
    // Both parts kept whole because first line has no '#'
    assert(result.includes('No heading here.\n\nFirst.'))
    assert(result.includes('No heading here.\n\nSecond.'))
  })
})

// ─── selectCompleteSections ──────────────────────────────────────────────────

describe('selectCompleteSections', () => {
  function chunk(content, meta, similarity = 0.5) {
    return { content, meta, similarity, embeddings: new Float32Array(1) }
  }

  const GRP_A = 'grp-a'
  const GRP_B = 'grp-b'
  const SRC_A = 'https://x.com/docs#section-a'
  const SRC_B = 'https://x.com/docs#section-b'

  test('maxResults <= 0 returns empty array', () => {
    const a = chunk('### A\n\nBody.', { groupID: GRP_A, source: SRC_A }, 0.9)
    assert.deepStrictEqual(selectCompleteSections([a], [a], 0), [])
    assert.deepStrictEqual(selectCompleteSections([a], [a], -1), [])
  })

  test('two results with the same groupID collapse to one; loop backfills to maxResults', () => {
    const a1 = chunk('### A\n\nPart 1.', { groupID: GRP_A, source: SRC_A }, 0.9)
    const a2 = chunk('### A\n\nPart 2.', { groupID: GRP_A, source: SRC_A }, 0.8)
    const b  = chunk('### B\n\nBody.', { source: SRC_B, headingPath: 'Root' }, 0.7)
    const allChunks = [a1, a2, b]
    const ranked = [a1, a2, b]
    const results = selectCompleteSections(ranked, allChunks, 2)
    assert.strictEqual(results.length, 2, 'must return maxResults results')
    assert(results[0].content.includes('Part 1.') && results[0].content.includes('Part 2.'), 'first result must be the joined section')
    assert.strictEqual(results[1].content, '### B\n\nBody.', 'second result must be the backfill')
  })

  test('two chunks with same source but no groupID stay as two separate results', () => {
    const c1 = chunk('### A\n\nResult 1.', { source: SRC_A, headingPath: 'Root' }, 0.9)
    const c2 = chunk('### A\n\nResult 2.', { source: SRC_A, headingPath: 'Root' }, 0.8)
    const allChunks = [c1, c2]
    const ranked = [c1, c2]
    const results = selectCompleteSections(ranked, allChunks, 2)
    assert.strictEqual(results.length, 2, 'chunks without groupID must not be combined')
  })

  test('mixed set: two groups and a standalone chunk give three results in score order', () => {
    const a1 = chunk('### G1\n\nPart 1.', { groupID: GRP_A, source: SRC_A }, 0.9)
    const a2 = chunk('### G1\n\nPart 2.', { groupID: GRP_A, source: SRC_A }, 0.5)
    const b1 = chunk('### G2\n\nPart 1.', { groupID: GRP_B, source: SRC_B }, 0.8)
    const b2 = chunk('### G2\n\nPart 2.', { groupID: GRP_B, source: SRC_B }, 0.4)
    const standalone = chunk('Standalone.', undefined, 0.7)
    const allChunks = [a1, b1, standalone, a2, b2]
    const ranked    = [a1, b1, standalone, a2, b2]  // score order
    const results = selectCompleteSections(ranked, allChunks, 5)
    assert.strictEqual(results.length, 3)
    assert(results[0].content.includes('Part 1.') && results[0].content.includes('Part 2.'), 'G1 result must be joined')
    assert(results[1].content.includes('G2'), 'G2 result must be present')
    assert(results[2].content.includes('Standalone'), 'standalone must pass through')
  })

  test('fewer distinct results than maxResults returns all without crash', () => {
    const a = chunk('### A\n\nBody.', { groupID: GRP_A, source: SRC_A }, 0.9)
    const allChunks = [a]
    const ranked = [a]
    const results = selectCompleteSections(ranked, allChunks, 5)
    assert.strictEqual(results.length, 1, 'only one result is available')
  })

  test('standalone chunks (no meta) are never deduplicated', () => {
    const c1 = chunk('Chunk one.', undefined, 0.9)
    const c2 = chunk('Chunk two.', null, 0.8)
    const allChunks = [c1, c2]
    const ranked = [c1, c2]
    const results = selectCompleteSections(ranked, allChunks, 2)
    assert.strictEqual(results.length, 2, 'both standalone chunks must pass through')
  })

  test('combined result keeps the top-ranked part meta', () => {
    const a1 = chunk('### A\n\nPart 1.', { groupID: GRP_A, source: SRC_A }, 0.5)
    const a2 = chunk('### A\n\nPart 2.', { groupID: GRP_A, source: SRC_A }, 0.9)
    const allChunks = [a1, a2]
    const ranked = [a2, a1]  // a2 is top-ranked
    const results = selectCompleteSections(ranked, allChunks, 1)
    assert.strictEqual(results.length, 1)
    assert.deepStrictEqual(results[0].meta, { groupID: GRP_A, source: SRC_A }, 'meta must come from the top-ranked part')
  })

  test('two split groups each yield one joined result', () => {
    const bj1 = chunk('### B\n\nJava part 1.', { groupID: 'java-grp', source: SRC_B }, 0.9)
    const bn1 = chunk('### B\n\nNode part 1.', { groupID: 'node-grp', source: SRC_B }, 0.8)
    const bj2 = chunk('### B\n\nJava part 2.', { groupID: 'java-grp', source: SRC_B }, 0.7)
    const bn2 = chunk('### B\n\nNode part 2.', { groupID: 'node-grp', source: SRC_B }, 0.6)
    const allChunks = [bj1, bj2, bn1, bn2]  // document order
    const ranked    = [bj1, bn1, bj2, bn2]  // score order
    const results = selectCompleteSections(ranked, allChunks, 5)
    assert.strictEqual(results.length, 2, 'java group + node group = 2 results')
    const javaResult = results.find(r => r.content.includes('Java part'))
    const nodeResult = results.find(r => r.content.includes('Node part'))
    assert.ok(javaResult, 'Java result must exist')
    assert.ok(nodeResult, 'Node.js result must exist')
    assert(javaResult.content.includes('Java part 1.') && javaResult.content.includes('Java part 2.'), 'Java parts must be joined')
    assert(nodeResult.content.includes('Node part 1.') && nodeResult.content.includes('Node part 2.'), 'Node.js parts must be joined')
  })
})

// ─── searchMarkdownDocs (section completion) — integration ───────────────────

describe('searchMarkdownDocs (section completion)', () => {
  const metaDirs = []

  after(async () => {
    await Promise.all(metaDirs.map(d => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
  })

  // Builds a bundle with custom chunks + metadata, writes .json and .bin to a
  // temp directory, and returns the directory path for use with { versionDir }.
  async function buildMetadataBundle(chunks, metadata) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-integ-'))
    metaDirs.push(dir)
    const frame = await buildTestBundle({ chunks, metadata })
    const jsonLen = frame.readUInt32BE(0)
    const jsonBuf = frame.slice(4, 4 + jsonLen)
    const binBuf = frame.slice(4 + jsonLen)
    await fs.writeFile(path.join(dir, 'code-chunks.json'), jsonBuf)
    await fs.writeFile(path.join(dir, 'code-chunks.bin'), binBuf)
    return dir
  }

  test('a split section (two chunks, same groupID) returns one result, title once, both bodies', async () => {
    const chunks = [
      '### srv.on()\n\nRegister event handlers with srv.on(). Handlers run when the event fires.',
      '### srv.on()\n\nThe event argument can be CREATE READ UPDATE DELETE or a custom action.',
      'Unrelated chunk about database connections and HANA setup for comparison.',
      'Another unrelated chunk about CDS entity definitions and projections.',
    ]
    const metadata = [
      { groupID: 'srv-on-split', source: 'https://example.com/docs#srv-on', headingPath: 'Core Services' },
      { groupID: 'srv-on-split', source: 'https://example.com/docs#srv-on', headingPath: 'Core Services' },
      { source: 'https://example.com/docs#hana', headingPath: 'Getting Started' },
      { source: 'https://example.com/docs#entities', headingPath: 'CDS' },
    ]
    const versionDir = await buildMetadataBundle(chunks, metadata)
    const result = await searchMarkdownDocs('srv.on event handler register', 5, { versionDir })
    const parts = result.split('\n---\n')
    const srvOnPart = parts.find(p => p.includes('srv.on()'))
    assert.ok(srvOnPart, 'result must include the srv.on section')
    assert(srvOnPart.includes('Register event handlers'), 'first part body must be present')
    assert(srvOnPart.includes('event argument'), 'second part body must be present')
    const titleCount = (srvOnPart.match(/### srv\.on\(\)/g) || []).length
    assert.strictEqual(titleCount, 1, 'title must appear exactly once in the combined result')
  })

  test('two chunks sharing a source but with no groupID return two separate results', async () => {
    const chunks = [
      '### Service Implementation\n\nIn Java extend ApplicationService and override handle methods.',
      '### Service Implementation\n\nIn Node.js extend cds.ApplicationService and implement init().',
      'Unrelated chunk about CDS entity definitions and primary keys.',
    ]
    const metadata = [
      { source: 'https://example.com/docs#impl', headingPath: 'Guides' },
      { source: 'https://example.com/docs#impl', headingPath: 'Guides' },
      { source: 'https://example.com/docs#entities', headingPath: 'CDS' },
    ]
    const versionDir = await buildMetadataBundle(chunks, metadata)
    const result = await searchMarkdownDocs('service implementation', 5, { versionDir })
    const parts = result.split('\n---\n')
    const implParts = parts.filter(p => p.includes('Service Implementation'))
    assert.strictEqual(implParts.length, 2, 'same source without groupID must return two results')
  })

  test('result count stays at maxResults when enough distinct results exist', async () => {
    const chunks = [
      '### Section A\n\nContent about event handlers and service methods part one.',
      '### Section A\n\nContent about event handlers lifecycle hooks part two.',
      '### Section B\n\nContent about entity definitions and data models.',
      '### Section C\n\nContent about service projections and associations.',
      '### Section D\n\nContent about authentication and authorization.',
    ]
    const metadata = [
      { groupID: 'split-a', source: 'https://example.com/docs#a', headingPath: 'Root' },
      { groupID: 'split-a', source: 'https://example.com/docs#a', headingPath: 'Root' },
      { source: 'https://example.com/docs#b', headingPath: 'Root' },
      { source: 'https://example.com/docs#c', headingPath: 'Root' },
      { source: 'https://example.com/docs#d', headingPath: 'Root' },
    ]
    const versionDir = await buildMetadataBundle(chunks, metadata)
    const result = await searchMarkdownDocs('service entity content', 3, { versionDir })
    const parts = result.split('\n---\n')
    assert.strictEqual(parts.length, 3, 'must return exactly maxResults results')
  })

  test('backward compat: bundle with no metadata still returns --- separated results', async () => {
    const chunks = [
      'To create a new CAP project run cds init my-project.',
      'Define CDS entities: entity Books { key ID: Integer; title: String; }',
      'Expose entities via services: service CatalogService { entity Books as projection on my.Books; }',
    ]
    const versionDir = await buildMetadataBundle(chunks, undefined)
    const result = await searchMarkdownDocs('entity service', 2, { versionDir })
    assert(typeof result === 'string', 'result must be a string')
    assert(result.length > 0, 'result must not be empty')
    assert(result.includes('---'), 'result must contain --- separators')
  })
})
