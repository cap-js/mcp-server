import cds from '@sap/cds'
import { buildTextSearchIndex } from './textSearchFallback.js'

// Full-text search over chunks using SQLite FTS5, or the JS term-frequency fallback
// when node:sqlite is compiled without SQLITE_ENABLE_FTS5 (Node.js < 24).
// Returns { idx, score }[] sorted ascending by score (lower = more relevant).
export async function fullTextSearch(query, chunks, limit) {
  const ftsQuery = toFts5Query(query)
  if (!ftsQuery) return []
  const db = await buildIndex(chunks)
  try {
    return queryIndex(db, ftsQuery, limit)
  } finally {
    await db.close()
  }
}

// Build an in-memory index from chunks — FTS5 when available, JS fallback otherwise.
async function buildIndex(chunks) {
  const svc = await cds.connect.to({ kind: 'sqlite', credentials: { database: ':memory:' } })
  const tx = await svc.begin()
  const { dbc } = tx

  try {
    dbc.exec("CREATE VIRTUAL TABLE fts USING fts5(content, tokenize='unicode61 remove_diacritics 1')")
  } catch (e) {
    await tx.rollback()
    if (e.code === 'ERR_SQLITE_ERROR' && e.message?.includes('no such module')) return buildTextSearchIndex(chunks)
    throw e
  }

  const insert = dbc.prepare('INSERT INTO fts(rowid, content) VALUES (?, ?)')
  for (let i = 0; i < chunks.length; i++) insert.run([i + 1, chunks[i].content])

  return { prepare: sql => dbc.prepare(sql), close: () => tx.rollback() }
}

// Query the index. bm25() returns negative values — smaller = more relevant —
// so ORDER BY score (ascending) gives most-relevant first.
// Returns [] when the MATCH expression fails.
function queryIndex(db, ftsQuery, limit) {
  try {
    return db
      .prepare('SELECT rowid - 1 AS idx, bm25(fts) AS score FROM fts WHERE fts MATCH ? ORDER BY score LIMIT ?')
      .all([ftsQuery, limit])
  } catch {
    return []
  }
}

// Extract plain word tokens from a query string and produce a safe FTS5 MATCH
// expression using OR semantics. Each token is double-quoted to prevent FTS5
// from interpreting reserved words (AND, OR, NOT) as operators.
// Returns null for queries that yield no tokens.
export function toFts5Query(query) {
  const tokens = query.toLowerCase().match(/\b[a-z][a-z0-9]*\b/g) ?? []
  return tokens.length ? tokens.map(t => `"${t}"`).join(' OR ') : null
}
