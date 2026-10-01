import cds from '@sap/cds'

// Build an in-memory FTS5 index and query it.
// Throws when node:sqlite is compiled without SQLITE_ENABLE_FTS5:
//   e.code === 'ERR_SQLITE_ERROR' && e.message includes 'no such module'
// Callers that want a fallback should catch that error themselves.
export async function fts5Search(query, chunks, limit) {
  const ftsQuery = toFts5Query(query)
  if (!ftsQuery) return []

  const svc = await cds.connect.to({ kind: 'sqlite', credentials: { database: ':memory:' } })
  const tx = await svc.begin()
  const { dbc } = tx
  try {
    dbc.exec("CREATE VIRTUAL TABLE fts USING fts5(content, tokenize='unicode61 remove_diacritics 1')")
    const insert = dbc.prepare('INSERT INTO fts(rowid, content) VALUES (?, ?)')
    for (let i = 0; i < chunks.length; i++) insert.run([i + 1, chunks[i].content])
    try {
      return dbc
        .prepare('SELECT rowid - 1 AS idx, bm25(fts) AS score FROM fts WHERE fts MATCH ? ORDER BY score LIMIT ?')
        .all([ftsQuery, limit])
    } catch {
      return []
    }
  } finally {
    await tx.rollback()
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
