import { DatabaseSync } from 'node:sqlite'

// Build an in-memory SQLite FTS5 index from loaded chunks.
// The index is built once per query — no per-session state needed.
// Returns the open DatabaseSync instance; caller must call db.close() when done.
export function buildFTS5Index(chunks) {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE VIRTUAL TABLE fts USING fts5(content, tokenize='unicode61 remove_diacritics 1')")
  const insert = db.prepare('INSERT INTO fts(rowid, content) VALUES (?, ?)')
  db.exec('BEGIN')
  for (let i = 0; i < chunks.length; i++) insert.run(i + 1, chunks[i].content)
  db.exec('COMMIT')
  return db
}

// Query the FTS5 index. bm25() returns negative values — smaller = more relevant —
// so ORDER BY score (ascending) gives most-relevant first.
// Returns [] when ftsQuery is null/empty or the MATCH expression fails.
export function queryFTS5(db, ftsQuery, limit) {
  if (!ftsQuery) return []
  try {
    return db
      .prepare('SELECT rowid - 1 AS idx, bm25(fts) AS score FROM fts WHERE fts MATCH ? ORDER BY score LIMIT ?')
      .all(ftsQuery, limit)
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
