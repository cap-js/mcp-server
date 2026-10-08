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
const { formatResult, sectionKey, buildSectionIndex, joinSectionParts, completeSection, selectCompleteSections } = searchModule

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

// ─── sectionKey ──────────────────────────────────────────────────────────────

describe('sectionKey', () => {
  test('returns null when meta is undefined', () => {
    assert.strictEqual(sectionKey(undefined), null)
  })

  test('returns null when meta is null', () => {
    assert.strictEqual(sectionKey(null), null)
  })

  test('returns null when meta has no source', () => {
    assert.strictEqual(sectionKey({ headingPath: 'Root' }), null)
  })

  test('returns source + NUL + empty string when label is absent', () => {
    const key = sectionKey({ source: 'https://x.com/#foo', headingPath: 'Root' })
    assert.strictEqual(key, 'https://x.com/#foo\0')
  })

  test('returns source + NUL + label when label is present', () => {
    const key = sectionKey({ source: 'https://x.com/#foo', headingPath: 'Root', label: 'java' })
    assert.strictEqual(key, 'https://x.com/#foo\0java')
  })

  test('same source + different label produces different keys', () => {
    const kJava = sectionKey({ source: 'https://x.com/#foo', label: 'java' })
    const kNode = sectionKey({ source: 'https://x.com/#foo', label: 'node' })
    assert.notStrictEqual(kJava, kNode)
  })
})

// ─── buildSectionIndex ───────────────────────────────────────────────────────

describe('buildSectionIndex', () => {
  const SRC = 'https://x.com/#sec'

  test('groups all parts for a source into one entry in document order', () => {
    const c1 = { content: 'Part 1', meta: { source: SRC, headingPath: 'Root' }, embeddings: new Float32Array(1) }
    const c2 = { content: 'Part 2', meta: { source: SRC, headingPath: 'Root' }, embeddings: new Float32Array(1) }
    const index = buildSectionIndex([c1, c2])
    const entry = index.get(SRC)
    assert.ok(entry, 'index must have an entry for the source')
    assert.strictEqual(entry.parts.length, 2)
    assert.strictEqual(entry.parts[0].chunk.content, 'Part 1')
    assert.strictEqual(entry.parts[1].chunk.content, 'Part 2')
  })

  test('keeps Java and Node.js parts in the same entry, tagged with their label', () => {
    const cJava = { content: 'Java', meta: { source: SRC, label: 'java' }, embeddings: new Float32Array(1) }
    const cNode = { content: 'Node', meta: { source: SRC, label: 'node' }, embeddings: new Float32Array(1) }
    const index = buildSectionIndex([cJava, cNode])
    assert.strictEqual(index.size, 1, 'both variants must share one entry')
    const entry = index.get(SRC)
    assert.strictEqual(entry.parts.filter(p => p.label === 'java').length, 1)
    assert.strictEqual(entry.parts.filter(p => p.label === 'node').length, 1)
  })

  test('skips chunks with no source', () => {
    const cNoMeta  = { content: 'A', embeddings: new Float32Array(1) }
    const cNullMeta = { content: 'B', meta: null, embeddings: new Float32Array(1) }
    const cNoSource = { content: 'C', meta: { headingPath: 'Root' }, embeddings: new Float32Array(1) }
    const index = buildSectionIndex([cNoMeta, cNullMeta, cNoSource])
    assert.strictEqual(index.size, 0, 'no entries must exist for sourceless chunks')
  })

  test('a one-part section produces an entry with one part', () => {
    const c = { content: 'Only', meta: { source: SRC, headingPath: 'Root' }, embeddings: new Float32Array(1) }
    const index = buildSectionIndex([c])
    assert.strictEqual(index.get(SRC)?.parts.length, 1)
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

// ─── completeSection ─────────────────────────────────────────────────────────

describe('completeSection', () => {
  const SRC = 'https://x.com/#sec'
  const META = { source: SRC, headingPath: 'Root' }

  test('pure general section: all parts are joined, meta is unchanged', () => {
    const c1 = { content: '### A\n\nPart 1.', meta: META, embeddings: new Float32Array(1) }
    const c2 = { content: '### A\n\nPart 2.', meta: META, embeddings: new Float32Array(1) }
    const index = buildSectionIndex([c1, c2])
    const result = completeSection(c1, index)
    assert(result.content.includes('Part 1.') && result.content.includes('Part 2.'), 'content must be joined')
    assert.strictEqual(result.meta, META, 'meta must be unchanged')
  })

  test('one-part section: result is returned unchanged', () => {
    const c = { content: '### A\n\nOnly.', meta: META, embeddings: new Float32Array(1) }
    const index = buildSectionIndex([c])
    const result = completeSection(c, index)
    assert.strictEqual(result, c, 'must return the same object reference')
  })

  test('no source in meta: result is returned unchanged', () => {
    const c = { content: 'Standalone.', meta: undefined, embeddings: new Float32Array(1) }
    const index = buildSectionIndex([])
    const result = completeSection(c, index)
    assert.strictEqual(result, c, 'must return the same object reference')
  })

  test('labelled result: content combines general parts then variant parts in document order', () => {
    const general = { content: '### X\n\nGeneral intro.', meta: { source: SRC, headingPath: 'Root' }, embeddings: new Float32Array(1) }
    const java    = { content: '### X\n\nJava details.', meta: { source: SRC, headingPath: 'Root', label: 'java' }, embeddings: new Float32Array(1) }
    const index = buildSectionIndex([general, java])
    const result = completeSection(java, index)
    assert(result.content.includes('General intro.'), 'general part must be included')
    assert(result.content.includes('Java details.'), 'Java part must be included')
    assert.strictEqual((result.content.match(/### X/g) || []).length, 1, 'title must appear once')
  })

  test('unlabelled chunk in a section with variants is returned unchanged', () => {
    const general = { content: '### X\n\nGeneral intro.', meta: { source: SRC, headingPath: 'Root' }, embeddings: new Float32Array(1) }
    const java    = { content: '### X\n\nJava details.', meta: { source: SRC, headingPath: 'Root', label: 'java' }, embeddings: new Float32Array(1) }
    const index = buildSectionIndex([general, java])
    const result = completeSection(general, index)
    assert.strictEqual(result, general, 'must return the same object reference')
  })
})

// ─── selectCompleteSections ──────────────────────────────────────────────────

describe('selectCompleteSections', () => {
  function chunk(content, meta, similarity = 0.5) {
    return { content, meta, similarity, embeddings: new Float32Array(1) }
  }

  const SRC_A = 'https://x.com/docs#section-a'
  const SRC_B = 'https://x.com/docs#section-b'
  const META_A = { source: SRC_A, headingPath: 'Root' }
  const META_B_JAVA = { source: SRC_B, headingPath: 'Root', label: 'java' }
  const META_B_NODE = { source: SRC_B, headingPath: 'Root', label: 'node' }

  test('two results from same section collapse to one; loop backfills from next candidate', () => {
    const a1 = chunk('### A\n\nPart 1.', META_A, 0.9)
    const a2 = chunk('### A\n\nPart 2.', META_A, 0.8)
    const b  = chunk('### B\n\nBody.', { source: SRC_B, headingPath: 'Root' }, 0.7)
    const allChunks = [a1, a2, b]
    const ranked = [a1, a2, b]
    const results = selectCompleteSections(ranked, allChunks, 2)
    assert.strictEqual(results.length, 2, 'must return maxResults results')
    assert(results[0].content.includes('Part 1.') && results[0].content.includes('Part 2.'), 'first result must be the joined section')
    assert.strictEqual(results[1].content, '### B\n\nBody.', 'second result must be the backfill')
  })

  test('Java and Node.js parts of one source stay as two separate results', () => {
    const bJava = chunk('### B\n\nJava.', META_B_JAVA, 0.9)
    const bNode = chunk('### B\n\nNode.', META_B_NODE, 0.8)
    const allChunks = [bJava, bNode]
    const ranked = [bJava, bNode]
    const results = selectCompleteSections(ranked, allChunks, 2)
    assert.strictEqual(results.length, 2)
    assert(results[0].content.includes('Java.'), 'first result must be the Java part')
    assert(results[1].content.includes('Node.'), 'second result must be the Node.js part')
  })

  test('fewer distinct sections than maxResults returns all available without crash', () => {
    const a = chunk('### A\n\nBody.', META_A, 0.9)
    const allChunks = [a]
    const ranked = [a]
    const results = selectCompleteSections(ranked, allChunks, 5)
    assert.strictEqual(results.length, 1, 'only one section is available')
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
    const a1 = chunk('### A\n\nPart 1.', META_A, 0.5)
    const a2 = chunk('### A\n\nPart 2.', META_A, 0.9)
    const allChunks = [a1, a2]
    const ranked = [a2, a1]
    const results = selectCompleteSections(ranked, allChunks, 1)
    assert.strictEqual(results.length, 1)
    assert.deepStrictEqual(results[0].meta, META_A, 'meta must come from the top-ranked part')
  })

  test('section split by size and variant: Java parts combine, Node parts combine, two results', () => {
    const bj1 = chunk('### B\n\nJava part 1.', META_B_JAVA, 0.9)
    const bn1 = chunk('### B\n\nNode part 1.', META_B_NODE, 0.8)
    const bj2 = chunk('### B\n\nJava part 2.', META_B_JAVA, 0.7)
    const bn2 = chunk('### B\n\nNode part 2.', META_B_NODE, 0.6)
    const allChunks = [bj1, bj2, bn1, bn2]   // document order
    const ranked = [bj1, bn1, bj2, bn2]       // score order
    const results = selectCompleteSections(ranked, allChunks, 5)
    assert.strictEqual(results.length, 2, 'Java group + Node group = 2 results')
    const javaResult = results.find(r => r.meta?.label === 'java')
    const nodeResult = results.find(r => r.meta?.label === 'node')
    assert.ok(javaResult, 'Java result must exist')
    assert.ok(nodeResult, 'Node.js result must exist')
    assert(javaResult.content.includes('Java part 1.') && javaResult.content.includes('Java part 2.'), 'Java parts must be joined')
    assert(nodeResult.content.includes('Node part 1.') && nodeResult.content.includes('Node part 2.'), 'Node.js parts must be joined')
  })

  test('section with multiple general parts + multiple Java parts + multiple Node.js parts, interleaved in document order', () => {
    // Document order:  general1, java1, node1, general2, java2, node2
    // Score order:     general1 (0.95), java1 (0.90), node1 (0.85),
    //                  general2 (0.80), java2 (0.75), node2 (0.70)
    //
    // Expected Java result content  (parts at pos 0, 1, 3, 4 in document order):
    //   ### Complex  ← title once
    //   General intro: shared context.
    //   Java step 1.
    //   General notes: additional shared context.
    //   Java step 2.
    //
    // Expected Node.js result content  (parts at pos 0, 2, 3, 5 in document order):
    //   ### Complex  ← title once
    //   General intro: shared context.
    //   Node.js step 1.
    //   General notes: additional shared context.
    //   Node.js step 2.
    //
    // Neither general chunk must appear as a standalone result.
    const SRC       = 'https://x.com/docs#complex-section'
    const META_GEN  = { source: SRC, headingPath: 'Root' }
    const META_JAVA = { source: SRC, headingPath: 'Root', label: 'java' }
    const META_NODE = { source: SRC, headingPath: 'Root', label: 'node' }

    const general1 = chunk('### Complex\n\nGeneral intro: shared context.', META_GEN, 0.95)
    const java1    = chunk('### Complex\n\nJava step 1.', META_JAVA, 0.90)
    const node1    = chunk('### Complex\n\nNode.js step 1.', META_NODE, 0.85)
    const general2 = chunk('### Complex\n\nGeneral notes: additional shared context.', META_GEN, 0.80)
    const java2    = chunk('### Complex\n\nJava step 2.', META_JAVA, 0.75)
    const node2    = chunk('### Complex\n\nNode.js step 2.', META_NODE, 0.70)

    const allChunks = [general1, java1, node1, general2, java2, node2]  // document order
    const ranked    = [general1, java1, node1, general2, java2, node2]  // score order

    const results = selectCompleteSections(ranked, allChunks, 5)

    assert.strictEqual(results.length, 2, 'one result per variant; general chunks must not appear standalone')

    const javaResult = results.find(r => r.meta?.label === 'java')
    const nodeResult = results.find(r => r.meta?.label === 'node')
    assert.ok(javaResult, 'Java result must exist')
    assert.ok(nodeResult, 'Node.js result must exist')

    // Java result must contain general1, java1, general2, java2 — no Node.js content
    assert(javaResult.content.includes('General intro: shared context.'),    'Java result: general1 body')
    assert(javaResult.content.includes('Java step 1.'),                      'Java result: java1 body')
    assert(javaResult.content.includes('General notes: additional shared'),  'Java result: general2 body')
    assert(javaResult.content.includes('Java step 2.'),                      'Java result: java2 body')
    assert(!javaResult.content.includes('Node.js step'),                     'Java result: no Node.js content')

    // Node.js result must contain general1, node1, general2, node2 — no Java content
    assert(nodeResult.content.includes('General intro: shared context.'),    'Node.js result: general1 body')
    assert(nodeResult.content.includes('Node.js step 1.'),                   'Node.js result: node1 body')
    assert(nodeResult.content.includes('General notes: additional shared'),  'Node.js result: general2 body')
    assert(nodeResult.content.includes('Node.js step 2.'),                   'Node.js result: node2 body')
    assert(!nodeResult.content.includes('Java step'),                        'Node.js result: no Java content')

    // Title must appear exactly once in each result
    assert.strictEqual((javaResult.content.match(/### Complex/g) || []).length, 1, 'Java result: title once')
    assert.strictEqual((nodeResult.content.match(/### Complex/g) || []).length, 1, 'Node.js result: title once')

    // Document order must be preserved within each result
    const ji = s => javaResult.content.indexOf(s)
    assert(ji('General intro') < ji('Java step 1'),    'Java: general1 before java1')
    assert(ji('Java step 1')   < ji('General notes'),  'Java: java1 before general2')
    assert(ji('General notes') < ji('Java step 2'),    'Java: general2 before java2')

    const ni = s => nodeResult.content.indexOf(s)
    assert(ni('General intro') < ni('Node.js step 1'), 'Node.js: general1 before node1')
    assert(ni('Node.js step 1') < ni('General notes'), 'Node.js: node1 before general2')
    assert(ni('General notes') < ni('Node.js step 2'), 'Node.js: general2 before node2')
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

  test('a split section returns one result that holds both bodies, title once', async () => {
    const chunks = [
      '### srv.on()\n\nRegister event handlers with srv.on(). Handlers run when the event fires.',
      '### srv.on()\n\nThe event argument can be CREATE READ UPDATE DELETE or a custom action.',
      'Unrelated chunk about database connections and HANA setup for comparison.',
      'Another unrelated chunk about CDS entity definitions and projections.',
    ]
    const metadata = [
      { source: 'https://example.com/docs#srv-on', headingPath: 'Core Services' },
      { source: 'https://example.com/docs#srv-on', headingPath: 'Core Services' },
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

  test('Java and Node.js section returns two separate results', async () => {
    const chunks = [
      '### Service Implementation\n\nIn Java extend ApplicationService and override handle methods.',
      '### Service Implementation\n\nIn Node.js extend cds.ApplicationService and implement init().',
      'Unrelated chunk about CDS entity definitions and primary keys.',
    ]
    const metadata = [
      { source: 'https://example.com/docs#impl', headingPath: 'Guides', label: 'java' },
      { source: 'https://example.com/docs#impl', headingPath: 'Guides', label: 'node' },
      { source: 'https://example.com/docs#entities', headingPath: 'CDS' },
    ]
    const versionDir = await buildMetadataBundle(chunks, metadata)
    const result = await searchMarkdownDocs('service implementation', 5, { versionDir })
    const parts = result.split('\n---\n')
    const javaResult = parts.find(p => p.includes('Java'))
    const nodeResult = parts.find(p => p.includes('Node.js'))
    assert.ok(javaResult, 'Java variant result must be present')
    assert.ok(nodeResult, 'Node.js variant result must be present')
  })

  test('result count stays at maxResults when enough distinct sections exist', async () => {
    const chunks = [
      '### Section A\n\nContent about event handlers and service methods part one.',
      '### Section A\n\nContent about event handlers lifecycle hooks part two.',
      '### Section B\n\nContent about entity definitions and data models.',
      '### Section C\n\nContent about service projections and associations.',
      '### Section D\n\nContent about authentication and authorization.',
    ]
    const metadata = [
      { source: 'https://example.com/docs#a', headingPath: 'Root' },
      { source: 'https://example.com/docs#a', headingPath: 'Root' },
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
