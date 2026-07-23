// Level-A retrieval eval — metrics + helpers. No LLM required.
// Ground truth is keyed on the `Source:` URL that every doc chunk carries.

/** Extract the source URL from a chunk's content (the `Source: <url>` header). */
export function chunkSource(content) {
  const m = content.match(/Source:\s*(https?:\/\/\S+?)(?:\s|>|$)/i)
  return m ? m[1] : null
}

/** Is this chunk sourced from release notes? (pollution signal for #2764) */
export function isReleaseNote(content) {
  const src = chunkSource(content) || ''
  return /\/releases?\//i.test(src) || /release note/i.test(content.slice(0, 120))
}

/** A ranked chunk is relevant if its source URL contains any expected substring. */
export function isRelevant(content, expectedSubstrings) {
  const src = chunkSource(content)
  if (!src) return false
  return expectedSubstrings.some(s => src.includes(s))
}

/** Recall@k: 1 if a relevant chunk appears in the top-k, else 0. */
export function recallAtK(ranked, expected, k) {
  return ranked.slice(0, k).some(c => isRelevant(c.content, expected)) ? 1 : 0
}

/** Reciprocal rank of the first relevant hit (0 if none in the list). */
export function reciprocalRank(ranked, expected) {
  const idx = ranked.findIndex(c => isRelevant(c.content, expected))
  return idx === -1 ? 0 : 1 / (idx + 1)
}

/** Binary-relevance nDCG@k. IDCG is bounded by how many relevant chunks
 *  actually appear in the top-k, so the value stays in [0, 1]. */
export function ndcgAtK(ranked, expected, k) {
  const top = ranked.slice(0, k)
  let dcg = 0
  let relCount = 0
  for (let i = 0; i < top.length; i++) {
    if (isRelevant(top[i].content, expected)) {
      dcg += 1 / Math.log2(i + 2)
      relCount++
    }
  }
  if (relCount === 0) return 0
  // ideal: all relevant chunks packed at the top ranks
  let idcg = 0
  for (let i = 0; i < relCount; i++) idcg += 1 / Math.log2(i + 2)
  return dcg / idcg
}

/** Fraction of top-k that are release-note chunks. */
export function pollutionAtK(ranked, k) {
  const top = ranked.slice(0, k)
  if (!top.length) return 0
  return top.filter(c => isReleaseNote(c.content)).length / top.length
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

export function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
}
