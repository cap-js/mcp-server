import { test, describe } from 'node:test'
import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { buildFTS5Index, queryFTS5, toFts5Query } from '../lib/fts5.js'

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

describe('buildFTS5Index', () => {
  test('returns a DatabaseSync instance', () => {
    const db = buildFTS5Index([{ content: 'hello world' }])
    try {
      assert.ok(db instanceof DatabaseSync)
    } finally {
      db.close()
    }
  })

  test('indexes all chunks by rowid', () => {
    const chunks = [
      { content: 'entity books author' },
      { content: 'service catalog projection' },
      { content: 'OData query filter' }
    ]
    const db = buildFTS5Index(chunks)
    try {
      const { n } = db.prepare('SELECT count(*) AS n FROM fts').get()
      assert.strictEqual(n, 3)
    } finally {
      db.close()
    }
  })

  test('empty chunks array produces an empty index', () => {
    const db = buildFTS5Index([])
    try {
      const { n } = db.prepare('SELECT count(*) AS n FROM fts').get()
      assert.strictEqual(n, 0)
    } finally {
      db.close()
    }
  })
})

describe('queryFTS5', () => {
  test('returns empty array for null ftsQuery', () => {
    const db = buildFTS5Index([{ content: 'entity books' }])
    try {
      assert.deepStrictEqual(queryFTS5(db, null, 10), [])
    } finally {
      db.close()
    }
  })

  test('returns matching chunk indices (0-based)', () => {
    const chunks = [
      { content: 'entity books title author' },
      { content: 'weather forecast rain sun' }
    ]
    const db = buildFTS5Index(chunks)
    try {
      const results = queryFTS5(db, toFts5Query('entity books'), 10)
      const indices = results.map(r => r.idx)
      assert.ok(indices.includes(0), 'chunk 0 should match')
      assert.ok(!indices.includes(1), 'chunk 1 should not match')
    } finally {
      db.close()
    }
  })

  test('chunk matching more query terms ranks first', () => {
    const chunks = [
      { content: 'entity books author' },         // matches 'entity' only
      { content: 'entity service query filter' }  // matches 'entity' and 'service'
    ]
    const db = buildFTS5Index(chunks)
    try {
      const results = queryFTS5(db, toFts5Query('entity service'), 10)
      assert.strictEqual(results[0].idx, 1, 'chunk 1 matches both terms and should rank first')
    } finally {
      db.close()
    }
  })

  test('respects the limit parameter', () => {
    const chunks = Array.from({ length: 10 }, (_, i) => ({ content: `entity item number ${i}` }))
    const db = buildFTS5Index(chunks)
    try {
      const results = queryFTS5(db, '"entity"', 3)
      assert.ok(results.length <= 3)
    } finally {
      db.close()
    }
  })

  test('returns empty array on FTS5 syntax error without throwing', () => {
    const db = buildFTS5Index([{ content: 'hello world' }])
    try {
      // Bare AND/OR without operands is a syntax error in FTS5
      const results = queryFTS5(db, 'AND NOT', 10)
      assert.ok(Array.isArray(results))
    } finally {
      db.close()
    }
  })

  test('bm25 scores are negative (smaller = more relevant)', () => {
    const chunks = [{ content: 'entity books title author' }]
    const db = buildFTS5Index(chunks)
    try {
      const [r] = queryFTS5(db, '"entity"', 10)
      assert.ok(r.score < 0, `score should be negative, got ${r.score}`)
    } finally {
      db.close()
    }
  })
})
