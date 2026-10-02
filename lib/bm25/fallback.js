// JavaScript BM25 search used when SQLite FTS5 is not compiled into node:sqlite.
// Produces the same { idx, score }[] format with negative scores (lower = more relevant).
//
// Implements Okapi BM25: TF saturation + IDF + document length normalization.
// No English stemming.
// Stop words are handled naturally — common tokens get near-zero IDF weight.

const K1 = 1.2  // term frequency saturation (standard value)
const B  = 0.75 // document length normalization weight (standard value)

export function bm25FallbackSearch(query, chunks, limit) {
  const tokens = query.toLowerCase().match(/\b[a-z][a-z0-9]*\b/g) ?? []
  if (!tokens.length) return []

  const N = chunks.length
  const contents = chunks.map(c => c.content.toLowerCase())

  const docLengths = contents.map(c => c.split(/\s+/).filter(Boolean).length)
  const avgdl = docLengths.reduce((s, l) => s + l, 0) / (N || 1)

  const df = new Map(tokens.map(t => [t, contents.filter(c => c.includes(t)).length]))

  return contents
    .map((content, idx) => {
      const dl = docLengths[idx]
      let score = 0

      for (const token of tokens) {
        let tf = 0, pos = 0
        while ((pos = content.indexOf(token, pos)) !== -1) { tf++; pos++ }
        if (tf === 0) continue

        const dft = df.get(token)
        const idf = Math.log((N - dft + 0.5) / (dft + 0.5) + 1)
        const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl / avgdl))
        score += idf * tfNorm
      }

      return { idx, score: -score }
    })
    .filter(r => r.score < 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
}
