import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'

// Mock the search module before retrieval.js imports it. The test script runs
// with --experimental-test-module-mocks, so the mock applies to the dynamic
// import below.
let lastCall
let searchResult = null
mock.module('../../../lib/searchMarkdownDocs.js', {
  defaultExport: async (query, maxResults, opts) => {
    lastCall = { query, maxResults, opts }
    return searchResult
  }
})

const { makeSearchDocsRunner } = await import('../../lib/retrieval.js')

const SOURCE_MAP = [
  { source: '/docs/a', title: 'A', depth: 1 },
  { source: '/docs/b', title: 'B', depth: 1 }
]

const Q = { id: 'q1', question: 'how do I do X?' }

describe('search-docs tests', () => {
  test('makeSearchDocsRunner returns a retrieve function', async () => {
    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP)
    assert.equal(typeof retrieve, 'function')
  })

  test('retrieve calls searchMarkdownDocs with query, maxResults=k and versionDir', async () => {
    searchResult = null
    const retrieve = await makeSearchDocsRunner(3, SOURCE_MAP, '/some/dir')
    await retrieve(Q).catch(() => {})
    assert.equal(lastCall.query, 'how do I do X?')
    assert.equal(lastCall.maxResults, 3)
    assert.deepEqual(lastCall.opts, { versionDir: '/some/dir' })
  })

  test('retrieve returns empty array when searchMarkdownDocs returns null/empty', async () => {
    searchResult = null
    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP)
    const result = await retrieve({ id: 'q1', question: 'q' })
    assert.deepEqual(result, [])
  })

  test('retrieve splits on \\n---\\n and resolves ids via sourceMap', async () => {
    searchResult = '# A\n\nSource: /docs/a\nbody\n---\n# B\n\nSource: /docs/b\nbody'
    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP)
    const result = await retrieve({ id: 'q1', question: 'q' })
    assert.equal(result.length, 2)
    assert.deepEqual(result[0].ids, ['/docs/a'])
    assert.deepEqual(result[1].ids, ['/docs/b'])
    assert.ok(result[0].text.includes('# A'))
  })
})
