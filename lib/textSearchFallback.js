// JavaScript term-frequency search used when SQLite FTS5 is not compiled into node:sqlite.
// Implements the same DB-like interface as buildFTS5Index so callers are transparent.
//
// Scoring: total occurrences of all matched tokens, negated so that a lower (more negative)
// score means more relevant — matching the BM25 convention from FTS5.

export function buildTextSearchIndex(chunks) {
  return {
    supported: false,
    prepare: () => ({
      all: ([ftsQuery, limit]) => searchChunks(chunks, ftsQuery, limit),
      get: () => null,
    }),
    close: async () => {},
  }
}

// Parse quoted tokens from an FTS5 MATCH expression ("token1" OR "token2"),
// score each chunk by total token occurrences, and return the top results.
function searchChunks(chunks, ftsQuery, limit) {
  const tokens = [...ftsQuery.matchAll(/"([^"]+)"/g)].map(m => m[1])
  if (!tokens.length) return []

  return chunks
    .map((chunk, idx) => {
      const content = chunk.content.toLowerCase()
      const termFreq = tokens.reduce((sum, token) => {
        let count = 0, pos = 0
        while ((pos = content.indexOf(token, pos)) !== -1) { count++; pos++ }
        return sum + count
      }, 0)
      return { idx, score: -termFreq }
    })
    .filter(r => r.score < 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
}
