import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'
import { makeSearchDocsRunner } from '../../lib/retrieval.js'

const SOURCE_MAP = [
  { source: '/docs/a', title: 'A', depth: 1 },
  { source: '/docs/b', title: 'B', depth: 1 }
]

const Q = { id: 'q1', question: 'how do I do X?' }

describe('search-docs tests', () => {
  test('makeSearchDocsRunner returns a retrieve function', async () => {
    const search = mock.fn(async () => null)
    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP, search)
    assert.equal(typeof retrieve, 'function')
  })

  test('retrieve calls search with query and maxResults=k', async () => {
    const search = mock.fn(async () => null)
    const retrieve = await makeSearchDocsRunner(3, SOURCE_MAP, search)
    await retrieve(Q).catch(() => {})
    const [query, maxResults, opts] = search.mock.calls[0].arguments
    assert.equal(query, 'how do I do X?')
    assert.equal(maxResults, 3)
    assert.equal(opts, undefined)
  })

  test('retrieve returns empty array when search returns null/empty', async () => {
    const search = mock.fn(async () => null)
    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP, search)
    const result = await retrieve({ id: 'q1', question: 'q' })
    assert.deepEqual(result, [])
  })

  test('retrieve splits on \\n---\\n and resolves ids via sourceMap', async () => {
    const out = '# A\n\nSource: /docs/a\nbody\n---\n# B\n\nSource: /docs/b\nbody'
    const search = mock.fn(async () => out)
    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP, search)
    const result = await retrieve({ id: 'q1', question: 'q' })
    assert.equal(result.length, 2)
    assert.deepEqual(result[0].ids, ['/docs/a'])
    assert.deepEqual(result[1].ids, ['/docs/b'])
    assert.ok(result[0].text.includes('# A'))
  })
})
