import cds from '@sap/cds'

// Build an in-memory FTS5 index and query it.
export async function fts5Search(query, chunks, limit) {
  const ftsQuery = toFts5Query(query)
  if (!ftsQuery) return []

  const svc = await cds.connect.to({ kind: 'sqlite', credentials: { database: ':memory:' } })
  try {
    await svc.run("CREATE VIRTUAL TABLE fts USING fts5(content, tokenize='unicode61 remove_diacritics 1')")
    const values = chunks.map(() => '(?, ?)').join(',')
    const params = chunks.flatMap((c, i) => [i + 1, c.content])
    await svc.run(`INSERT INTO fts(rowid, content) VALUES ${values}`, params)
    try {
      return await svc.run(
        'SELECT rowid - 1 AS idx, bm25(fts) AS score FROM fts WHERE fts MATCH ? ORDER BY score LIMIT ?',
        [ftsQuery, limit]
      )
    } catch {
      return []
    }
  } finally {
    svc.disconnect()
  }
}

// Extract plain word tokens from a query string and produce a safe FTS5 MATCH
// expression using OR semantics. Each token is double-quoted to prevent FTS5
// from interpreting reserved words (AND, OR, NOT) as operators.
export function toFts5Query(query) {
  const tokens = query.toLowerCase().match(/\b[a-z][a-z0-9]*\b/g) ?? []
  return tokens.length ? tokens.map(t => `"${t}"`).join(' OR ') : null
}
