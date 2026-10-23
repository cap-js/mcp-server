import { it, describe, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { makeSearchDocsRunner, retrievalRuntime } from '../../lib/retrieval/retrieval.js'

const SOURCE_MAP = [
  { source: '/docs/a', title: 'A', depth: 1 },
  { source: '/docs/b', title: 'B', depth: 1 }
]

const Q = { id: 'q1', question: 'how do I do X?' }

describe('search-docs', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  it('should return a retrieve function', async () => {
    mock.method(
      retrievalRuntime,
      'searchMarkdownDocs',
      mock.fn(async () => null)
    )

    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP)

    assert.equal(typeof retrieve, 'function')
  })

  it('should call search with the question text and k as maxResults', async () => {
    const search = mock.fn(async () => null)
    mock.method(retrievalRuntime, 'searchMarkdownDocs', search)
    const retrieve = await makeSearchDocsRunner(3, SOURCE_MAP)

    await retrieve(Q)

    const [query, maxResults, opts] = search.mock.calls[0].arguments
    assert.equal(query, 'how do I do X?')
    assert.equal(maxResults, 3)
    assert.equal(opts, undefined)
  })

  it('should return an empty array when search returns null', async () => {
    mock.method(
      retrievalRuntime,
      'searchMarkdownDocs',
      mock.fn(async () => null)
    )
    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP)

    const result = await retrieve({ id: 'q1', question: 'q' })

    assert.deepEqual(result, [])
  })

  it('should split results on the separator and resolve ids from the source map', async () => {
    const out = '# A\n\nSource: /docs/a\nbody\n---\n# B\n\nSource: /docs/b\nbody'
    mock.method(
      retrievalRuntime,
      'searchMarkdownDocs',
      mock.fn(async () => out)
    )
    const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP)

    const result = await retrieve({ id: 'q1', question: 'q' })

    assert.equal(result.length, 2)
    assert.deepEqual(result[0].ids, ['/docs/a'])
    assert.deepEqual(result[1].ids, ['/docs/b'])
    assert.ok(result[0].text.includes('# A'))
  })

  describe('side-effects', () => {
    it('should not add properties to source map entries passed to makeSearchDocsRunner', async () => {
      const entry = { source: '/docs/a', title: 'A', depth: 1 }
      const keysBefore = Object.keys(entry)
      mock.method(
        retrievalRuntime,
        'searchMarkdownDocs',
        mock.fn(async () => null)
      )

      await makeSearchDocsRunner(5, [entry])

      assert.deepEqual(Object.keys(entry), keysBefore)
    })
  })
})
