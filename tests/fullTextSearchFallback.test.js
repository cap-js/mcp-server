import { test, describe, mock } from 'node:test'
import assert from 'node:assert'

mock.module('../lib/bm25/fts5.js', {
  namedExports: { fts5Search: async () => { throw new Error('fts5 unavailable') } }
})

const { fullTextSearch } = await import('../lib/embeddings.js')

describe('fullTextSearch', () => {
  test('uses fallback when fts5 is not available', async () => {
    const results = await fullTextSearch('entity', [{ content: 'entity books' }], 10)
    assert.ok(Array.isArray(results), 'should return results via fallback')
  })

  test('returns empty array for empty query', async () => {
    assert.deepStrictEqual(await fullTextSearch('', [{ content: 'entity books' }], 10), [])
  })

  test('returns matching chunk indices (0-based)', async () => {
    const chunks = [
      { content: 'entity books title author' },
      { content: 'weather forecast rain sun' }
    ]
    const results = await fullTextSearch('entity books', chunks, 10)
    const indices = results.map(r => r.idx)
    assert.ok(indices.includes(0), 'chunk 0 should match')
    assert.ok(!indices.includes(1), 'chunk 1 should not match')
  })

  test('chunk matching more query terms ranks first', async () => {
    const chunks = [
      { content: 'entity books author' },
      { content: 'entity service query filter' }
    ]
    const results = await fullTextSearch('entity service', chunks, 10)
    assert.strictEqual(results[0].idx, 1, 'chunk 1 matches both terms and should rank first')
  })

  test('respects the limit parameter', async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => ({ content: `entity item number ${i}` }))
    const results = await fullTextSearch('entity', chunks, 3)
    assert.ok(results.length <= 3)
  })

  test('returns empty array on FTS5 syntax error without throwing', async () => {
    const results = await fullTextSearch('AND NOT', [{ content: 'hello world' }], 10)
    assert.ok(Array.isArray(results))
  })

  test('scores are negative (smaller = more relevant)', async () => {
    const chunks = [{ content: 'entity books title author' }]
    const [r] = await fullTextSearch('entity', chunks, 10)
    assert.ok(r.score < 0, `score should be negative, got ${r.score}`)
  })
})
