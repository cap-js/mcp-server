import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { makeSearchDocsRunner } from '../../lib/search-docs.js'
import tools from '../../../lib/tools.js'

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

  test('retrieve calls search_docs with query and maxResults=k', async () => {
    let capturedArgs
    const orig = tools.search_docs.handler
    tools.search_docs.handler = async (args) => { capturedArgs = args; return null }
    try {
      const retrieve = await makeSearchDocsRunner(3, SOURCE_MAP)
      await retrieve(Q).catch(() => {})
      assert.equal(capturedArgs.query, 'how do I do X?')
      assert.equal(capturedArgs.maxResults, 3)
    } finally {
      tools.search_docs.handler = orig
    }
  })

  test('retrieve returns empty array when search_docs returns null/empty', async () => {
    const orig = tools.search_docs.handler
    tools.search_docs.handler = async () => null
    try {
      const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP)
      const result = await retrieve({ id: 'q1', question: 'q' })
      assert.deepEqual(result, [])
    } finally {
      tools.search_docs.handler = orig
    }
  })

  test('retrieve splits on \\n---\\n and resolves ids via sourceMap', async () => {
    const orig = tools.search_docs.handler
    // Two chunks, each with a heading resolvable via SOURCE_MAP
    tools.search_docs.handler = async () => '# A\n\nSource: /docs/a\nbody\n---\n# B\n\nSource: /docs/b\nbody'
    try {
      const retrieve = await makeSearchDocsRunner(5, SOURCE_MAP)
      const result = await retrieve({ id: 'q1', question: 'q' })
      assert.equal(result.length, 2)
      assert.deepEqual(result[0].ids, ['/docs/a'])
      assert.deepEqual(result[1].ids, ['/docs/b'])
      assert.ok(result[0].text.includes('# A'))
    } finally {
      tools.search_docs.handler = orig
    }
  })
})
