import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { loadIndex, loadChunkText, makeDefaultRetriever } from '../../lib/retriever.js'

// A fixture corpus: two real sections + a URL-less continuation of the second.
const CORPUS = {
  dim: 3,
  count: 3,
  chunks: [
    'Getting Started > Setup > Source: https://x/setup#a\nsetup body',
    'CDS > CDL > Source: https://x/cdl#b\ncdl body',
    'more cdl detail' // continuation → https://x/cdl#generated-anker-1
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
    assert.deepEqual(idx.ids, ['https://x/setup#a', 'https://x/cdl#b', 'https://x/cdl#generated-anker-1'])
    assert.ok(idx.idSet.has('https://x/cdl#generated-anker-1'))
  })

  test('loadChunkText maps every id back to its chunk text', async () => {
    const map = await loadChunkText(corpusPath)
    assert.equal(map.get('https://x/setup#a'), CORPUS.chunks[0])
    assert.equal(map.get('https://x/cdl#generated-anker-1'), CORPUS.chunks[2])
  })

  test('loadIndex throws on a corrupt/missing corpus', async () => {
    await fs.writeFile(corpusPath, '{"not":"chunks"}')
    await assert.rejects(() => loadIndex(corpusPath), /Corrupt or missing corpus/)
    await assert.rejects(() => loadIndex(path.join(tmpDir, 'nope.json')), /ENOENT|Corrupt/)
  })

  test('makeDefaultRetriever resolves search_docs output to corpus-consistent ids', async () => {
    // Fake search_docs returns the two real sections joined by the separator.
    const searchDocs = {
      handler: async ({ maxResults }) => {
        assert.equal(maxResults, 5)
        return `${CORPUS.chunks[0]}\n---\n${CORPUS.chunks[1]}`
      }
    }
    const retrieve = await makeDefaultRetriever(5, { searchDocs, corpusPath })
    assert.deepEqual(await retrieve('q'), ['https://x/setup#a', 'https://x/cdl#b'])
    // exposes the raw per-slot text of the last retrieval (aligned with the ids)
    assert.deepEqual(retrieve.lastTexts, [CORPUS.chunks[0], CORPUS.chunks[1]])
  })

  test('retriever matches a URL-less continuation chunk to its corpus generated-anker id', async () => {
    // search_docs returns the continuation text after a different page.
    const searchDocs = { handler: async () => `${CORPUS.chunks[0]}\n---\nmore cdl detail` }
    const retrieve = await makeDefaultRetriever(5, { searchDocs, corpusPath })
    // 'more cdl detail' matches CORPUS.chunks[2] → its corpus id, not a local one.
    assert.deepEqual(await retrieve('q'), ['https://x/setup#a', 'https://x/cdl#generated-anker-1'])
  })

  test('retriever returns [] when search_docs returns nothing', async () => {
    const searchDocs = { handler: async () => '' }
    const retrieve = await makeDefaultRetriever(5, { searchDocs, corpusPath })
    assert.deepEqual(await retrieve('q'), [])
  })

  test('switching corpusPath (model change) uses the new model corpus for id resolution', async () => {
    // A continuation chunk that appears in both corpora but under different predecessor
    // pages — so its resolved id depends on which corpus (model) is loaded.
    const sharedContinuation = 'some continuation chunk with no source annotation'

    // Model A: page-a is the predecessor of the continuation
    const corpusA = { chunks: [
      'A > Page > Source: https://x/page-a#s\nbody',
      sharedContinuation // → https://x/page-a#generated-anker-1 in model A
    ] }
    // Model B: page-b is the predecessor
    const corpusB = { chunks: [
      'B > Page > Source: https://x/page-b#s\nbody',
      sharedContinuation // → https://x/page-b#generated-anker-1 in model B
    ] }
    const pathA = path.join(tmpDir, 'corpus-a.json')
    const pathB = path.join(tmpDir, 'corpus-b.json')
    await fs.writeFile(pathA, JSON.stringify(corpusA))
    await fs.writeFile(pathB, JSON.stringify(corpusB))

    // search_docs returns the real section then the shared continuation
    const out = `${corpusA.chunks[0]}\n---\n${sharedContinuation}`
    const searchDocs = { handler: async () => out }

    const retrieveA = await makeDefaultRetriever(5, { searchDocs, corpusPath: pathA })
    const retrieveB = await makeDefaultRetriever(5, { searchDocs, corpusPath: pathB })

    const idsA = await retrieveA('q')
    const idsB = await retrieveB('q')

    // Model A resolves the continuation to page-a's generated-anker id
    assert.deepEqual(idsA, ['https://x/page-a#s', 'https://x/page-a#generated-anker-1'])
    // Model B resolves the same text to page-b's generated-anker id (different corpus)
    assert.deepEqual(idsB, ['https://x/page-a#s', 'https://x/page-b#generated-anker-1'])
  })
})
