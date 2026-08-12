import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { loadIndex, loadChunkText, makeSearchDocsRunner } from '../../lib/search-docs.js'

// A fixture corpus: two real sections + a chunk with no first-line Source: URL.
// A URL-less chunk has no id and is dropped (not scored) — the eval scores the
// tool's real output against correctly-formatted input, it does not invent ids.
const CORPUS = {
  dim: 3,
  count: 3,
  chunks: [
    'Getting Started > Setup > Source: https://x/setup#a\nsetup body',
    'CDS > CDL > Source: https://x/cdl#b\ncdl body',
    'more cdl detail' // no Source: URL → dropped
  ]
}

describe('search-docs tests', () => {
  let tmpDir, corpusPath
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-retriever-'))
    corpusPath = path.join(tmpDir, 'code-chunks.json')
    await fs.writeFile(corpusPath, JSON.stringify(CORPUS))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('loadIndex parses distinct ids + count from the corpus (URL-less dropped)', async () => {
    const idx = await loadIndex(corpusPath)
    assert.deepEqual(idx.ids, ['https://x/setup#a', 'https://x/cdl#b'])
    assert.equal(idx.count, 2)
    assert.ok(idx.idSet.has('https://x/setup#a'))
  })

  test('loadChunkText maps every id back to its chunk text', async () => {
    const map = await loadChunkText(corpusPath)
    assert.equal(map.get('https://x/setup#a'), CORPUS.chunks[0])
    assert.equal(map.get('https://x/cdl#b'), CORPUS.chunks[1])
  })

  test('loadIndex throws on a corrupt/missing corpus', async () => {
    await fs.writeFile(corpusPath, '{"not":"chunks"}')
    await assert.rejects(() => loadIndex(corpusPath), /Corrupt or missing corpus/)
    await assert.rejects(() => loadIndex(path.join(tmpDir, 'nope.json')), /ENOENT|Corrupt/)
  })

  test('makeSearchDocsRunner resolves search_docs output to corpus-consistent ids', async () => {
    const searchDocs = {
      handler: async ({ maxResults }) => {
        assert.equal(maxResults, 5)
        return `${CORPUS.chunks[0]}\n---\n${CORPUS.chunks[1]}`
      }
    }
    const retrieve = await makeSearchDocsRunner(5, { searchDocs, corpusPath })
    assert.deepEqual(await retrieve('q'), ['https://x/setup#a', 'https://x/cdl#b'])
    assert.deepEqual(retrieve.lastTexts, [CORPUS.chunks[0], CORPUS.chunks[1]])
  })

  test('a retrieved chunk with no Source: URL is dropped from the id list', async () => {
    const searchDocs = { handler: async () => `${CORPUS.chunks[0]}\n---\nmore cdl detail` }
    const retrieve = await makeSearchDocsRunner(5, { searchDocs, corpusPath })
    assert.deepEqual(await retrieve('q'), ['https://x/setup#a'])
  })

  test('retriever returns [] when search_docs returns nothing', async () => {
    const searchDocs = { handler: async () => '' }
    const retrieve = await makeSearchDocsRunner(5, { searchDocs, corpusPath })
    assert.deepEqual(await retrieve('q'), [])
  })

  test('switching corpusPath (model change) uses the new model corpus for id resolution', async () => {
    // Two corpora with different Source URLs; each retriever resolves against its own.
    const corpusA = { chunks: ['A > Page > Source: https://x/page-a#s\nbody'] }
    const corpusB = { chunks: ['B > Page > Source: https://x/page-b#s\nbody'] }
    const pathA = path.join(tmpDir, 'corpus-a.json')
    const pathB = path.join(tmpDir, 'corpus-b.json')
    await fs.writeFile(pathA, JSON.stringify(corpusA))
    await fs.writeFile(pathB, JSON.stringify(corpusB))

    const sdA = { handler: async () => corpusA.chunks[0] }
    const sdB = { handler: async () => corpusB.chunks[0] }

    const retrieveA = await makeSearchDocsRunner(5, { searchDocs: sdA, corpusPath: pathA })
    const retrieveB = await makeSearchDocsRunner(5, { searchDocs: sdB, corpusPath: pathB })

    assert.deepEqual(await retrieveA('q'), ['https://x/page-a#s'])
    assert.deepEqual(await retrieveB('q'), ['https://x/page-b#s'])
  })
})
