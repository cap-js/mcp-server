import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { makeSearchDocsRunner } from '../../lib/retrieval.js'

// A fake search function injected into makeSearchDocsRunner. This avoids a real
// embeddings load and keeps the test free of process-global module mocks.
function fakeSearch(result) {
  const calls = []
  const fn = async (query, maxResults, opts) => {
    calls.push({ query, maxResults, opts })
    return typeof result === 'function' ? result() : result
  }
  fn.calls = calls
  return fn
}

const SOURCE_MAP = [
  { source: '/docs/a', title: 'A', depth: 1 },
  { source: '/docs/b', title: 'B', depth: 1 }
]

const Q = { id: 'q1', question: 'how do I do X?' }

describe('search-docs tests', () => {
  test('makeSearchDocsRunner returns a retrieve function', async () => {
    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP, undefined, fakeSearch(null))
    assert.equal(typeof retrieve, 'function')
  })

  test('retrieve calls search with query, maxResults=k and versionDir', async () => {
    const search = fakeSearch(null)
    const retrieve = await makeSearchDocsRunner(3, SOURCE_MAP, '/some/dir', search)
    await retrieve(Q).catch(() => {})
    assert.equal(search.calls[0].query, 'how do I do X?')
    assert.equal(search.calls[0].maxResults, 3)
    assert.deepEqual(search.calls[0].opts, { versionDir: '/some/dir' })
  })

  test('retrieve returns empty array when search returns null/empty', async () => {
    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP, undefined, fakeSearch(null))
    const result = await retrieve({ id: 'q1', question: 'q' })
    assert.deepEqual(result, [])
  })

  test('retrieve splits on \\n---\\n and resolves ids via sourceMap', async () => {
    const out = '# A\n\nSource: /docs/a\nbody\n---\n# B\n\nSource: /docs/b\nbody'
    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP, undefined, fakeSearch(out))
    const result = await retrieve({ id: 'q1', question: 'q' })
    assert.equal(result.length, 2)
    assert.deepEqual(result[0].ids, ['/docs/a'])
    assert.deepEqual(result[1].ids, ['/docs/b'])
    assert.ok(result[0].text.includes('# A'))
  })
})
