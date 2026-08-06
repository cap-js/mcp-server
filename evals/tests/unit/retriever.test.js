import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { loadIndex, loadChunkText, makeDefaultRetriever } from '../../lib/retriever.js'

// A fixture corpus: two real sections + a breadcrumb-only chunk (no Source: URL).
// With the capire:// fallback, the breadcrumb-only chunk gets its own stable id.
const CORPUS = {
  dim: 3,
  count: 3,
  chunks: [
    'Getting Started > Setup > Source: https://x/setup#a\nsetup body',
    'CDS > CDL > Source: https://x/cdl#b\ncdl body',
    'more cdl detail' // breadcrumb-only → capire://generated/more-cdl-detail
  ]
}

describe('retriever tests', () => {
  let tmpDir, corpusPath
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-retriever-'))
    corpusPath = path.join(tmpDir, 'code-chunks.json')
    await fs.writeFile(corpusPath, JSON.stringify(CORPUS))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('loadIndex parses distinct ids + count from the corpus', async () => {
    const idx = await loadIndex(corpusPath)
    assert.equal(idx.count, 3)
    assert.equal(idx.ids[0], 'https://x/setup#a')
    assert.equal(idx.ids[1], 'https://x/cdl#b')
    assert.ok(idx.ids[2].startsWith('capire://generated/'))
    assert.ok(idx.idSet.has('capire://generated/more-cdl-detail'))
  })

  test('loadChunkText maps every id back to its chunk text', async () => {
    const map = await loadChunkText(corpusPath)
    assert.equal(map.get('https://x/setup#a'), CORPUS.chunks[0])
    assert.equal(map.get('capire://generated/more-cdl-detail'), CORPUS.chunks[2])
  })

  test('loadIndex throws on a corrupt/missing corpus', async () => {
    await fs.writeFile(corpusPath, '{"not":"chunks"}')
    await assert.rejects(() => loadIndex(corpusPath), /Corrupt or missing corpus/)
    await assert.rejects(() => loadIndex(path.join(tmpDir, 'nope.json')), /ENOENT|Corrupt/)
  })

  test('makeDefaultRetriever resolves search_docs output to corpus-consistent ids', async () => {
    const searchDocs = {
      handler: async ({ maxResults }) => {
        assert.equal(maxResults, 5)
        return `${CORPUS.chunks[0]}\n---\n${CORPUS.chunks[1]}`
      }
    }
    const retrieve = await makeDefaultRetriever(5, { searchDocs, corpusPath })
    assert.deepEqual(await retrieve('q'), ['https://x/setup#a', 'https://x/cdl#b'])
    assert.deepEqual(retrieve.lastTexts, [CORPUS.chunks[0], CORPUS.chunks[1]])
  })

  test('retriever resolves a breadcrumb-only chunk to its capire:// corpus id', async () => {
    // search_docs returns the breadcrumb-only chunk after a real section.
    const searchDocs = { handler: async () => `${CORPUS.chunks[0]}\n---\nmore cdl detail` }
    const retrieve = await makeDefaultRetriever(5, { searchDocs, corpusPath })
    // 'more cdl detail' text-matches CORPUS.chunks[2] → its capire:// corpus id.
    const ids = await retrieve('q')
    assert.equal(ids[0], 'https://x/setup#a')
    assert.equal(ids[1], 'capire://generated/more-cdl-detail')
  })

  test('retriever returns [] when search_docs returns nothing', async () => {
    const searchDocs = { handler: async () => '' }
    const retrieve = await makeDefaultRetriever(5, { searchDocs, corpusPath })
    assert.deepEqual(await retrieve('q'), [])
  })

  test('switching corpusPath (model change) uses the new model corpus for id resolution', async () => {
    // Two corpora with different chunks for the same breadcrumb-only text — the
    // resolved id depends on the corpus because the same text maps to different
    // ids when the surrounding context in the corpus is different (different
    // predecessor URL chunk). Here we use two distinct continuation texts so each
    // corpus uniquely owns one.
    const contA = 'unique continuation text for model A only'
    const contB = 'unique continuation text for model B only'

    const corpusA = { chunks: [
      'A > Page > Source: https://x/page-a#s\nbody',
      contA // → capire://generated/unique-continuation-text-for-model-a-only
    ] }
    const corpusB = { chunks: [
      'B > Page > Source: https://x/page-b#s\nbody',
      contB // → capire://generated/unique-continuation-text-for-model-b-only
    ] }
    const pathA = path.join(tmpDir, 'corpus-a.json')
    const pathB = path.join(tmpDir, 'corpus-b.json')
    await fs.writeFile(pathA, JSON.stringify(corpusA))
    await fs.writeFile(pathB, JSON.stringify(corpusB))

    // Model A retrieves contA; model B retrieves contB.
    const sdA = { handler: async () => `${corpusA.chunks[0]}\n---\n${contA}` }
    const sdB = { handler: async () => `${corpusB.chunks[0]}\n---\n${contB}` }

    const retrieveA = await makeDefaultRetriever(5, { searchDocs: sdA, corpusPath: pathA })
    const retrieveB = await makeDefaultRetriever(5, { searchDocs: sdB, corpusPath: pathB })

    const idsA = await retrieveA('q')
    const idsB = await retrieveB('q')

    // Each retriever resolved against its own corpus — different ids.
    assert.equal(idsA[0], 'https://x/page-a#s')
    assert.ok(idsA[1].includes('model-a'))
    assert.equal(idsB[0], 'https://x/page-b#s')
    assert.ok(idsB[1].includes('model-b'))
    assert.notEqual(idsA[1], idsB[1])
  })
})
