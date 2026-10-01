import { test, describe } from 'node:test'
import assert from 'node:assert'
import { fullTextSearch } from '../lib/embeddings.js'
import { toFts5Query } from '../lib/bm25/fts5.js'

describe('toFts5Query', () => {
  test('lowercases tokens and joins with OR', () => {
    assert.strictEqual(toFts5Query('Entity Service'), '"entity" OR "service"')
  })

  test('wraps each token in double quotes', () => {
    const result = toFts5Query('and or not')
    assert.strictEqual(result, '"and" OR "or" OR "not"')
  })

  test('strips FTS5 special characters — only plain word tokens pass', () => {
    const result = toFts5Query('foo* bar-baz "quoted" ???')
    assert.strictEqual(result, '"foo" OR "bar" OR "baz" OR "quoted"')
  })

  test('includes alphanumeric tokens starting with a letter', () => {
    assert.strictEqual(toFts5Query('cds2 v10'), '"cds2" OR "v10"')
  })

  test('returns null for empty string', () => {
    assert.strictEqual(toFts5Query(''), null)
  })

  test('returns null when no word tokens remain after stripping', () => {
    assert.strictEqual(toFts5Query('123 456 ***'), null)
  })
})

describe('fullTextSearch', () => {
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
      { content: 'entity books author' },         // matches 'entity' only
      { content: 'entity service query filter' }  // matches 'entity' and 'service'
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
    // Bare AND/OR without operands is a syntax error in FTS5
    const results = await fullTextSearch('AND NOT', [{ content: 'hello world' }], 10)
    assert.ok(Array.isArray(results))
  })

  test('scores are negative (smaller = more relevant)', async () => {
    const chunks = [{ content: 'entity books title author' }]
    const [r] = await fullTextSearch('entity', chunks, 10)
    assert.ok(r.score < 0, `score should be negative, got ${r.score}`)
  })
})
