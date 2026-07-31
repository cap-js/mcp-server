// Pure-arithmetic retrieval metrics. Binary relevance.
// No I/O, no randomness, no LLM, no wall-clock. Deterministic given inputs.
//
// Conventions:
// - `relevant` : array of relevant doc ids (the authored ground truth for a question)
// - `retrieved`: the raw ranked result SLOTS search_docs returned (best first).
//                Duplicates are KEPT — a page occupying 3 of the K slots counts as
//                3 slots. This mirrors exactly what a caller asking for `maxResults=k`
//                receives; the eval scores the tool's real output, not a cleaned copy.
// - `k`        : cutoff (top-K slots)

function topK(retrieved, k) {
  return retrieved.slice(0, k) // raw slots, no dedup
}

// 1-based ranks (within top-K) at which a relevant doc appears (per slot).
export function relevantHitsAtRank(relevant, retrieved, k) {
  const rel = new Set(relevant)
  const ranks = []
  const top = topK(retrieved, k)
  for (let i = 0; i < top.length; i++) {
    if (rel.has(top[i])) ranks.push(i + 1)
  }
  return ranks
}

// Recall counts DISTINCT relevant docs found (a relevant page in several slots
// is still one doc), divided by the number of relevant docs — so recall ∈ [0,1].
export function recallAtK(relevant, retrieved, k) {
  const rel = new Set(relevant)
  if (rel.size === 0) return 0
  const top = topK(retrieved, k)
  const found = new Set()
  for (const id of top) if (rel.has(id)) found.add(id)
  return found.size / rel.size
}

// Precision counts relevant SLOTS / k — duplicates count, matching "of the k
// results the caller got, how many were relevant".
export function precisionAtK(relevant, retrieved, k) {
  if (k <= 0) return 0
  const rel = new Set(relevant)
  const top = topK(retrieved, k)
  let hits = 0
  for (const id of top) if (rel.has(id)) hits++
  return hits / k
}

export function mrr(relevant, retrieved, k) {
  const rel = new Set(relevant)
  const top = topK(retrieved, k)
  for (let i = 0; i < top.length; i++) {
    if (rel.has(top[i])) return 1 / (i + 1)
  }
  return 0
}

export function hitRateAtK(relevant, retrieved, k) {
  const rel = new Set(relevant)
  const top = topK(retrieved, k)
  for (const id of top) if (rel.has(id)) return 1
  return 0
}

// nDCG over the raw slots: each relevant slot contributes a rank-discounted gain.
// Ideal DCG packs the DISTINCT relevant docs at the top (a doc is worth finding
// once), so nDCG ∈ [0,1] even when a relevant page repeats across slots.
export function ndcgAtK(relevant, retrieved, k) {
  const rel = new Set(relevant)
  if (rel.size === 0) return 0
  const top = topK(retrieved, k)
  let dcg = 0
  for (let i = 0; i < top.length; i++) {
    if (rel.has(top[i])) dcg += 1 / Math.log2(i + 2) // rank i+1 → log2((i+1)+1)
  }
  const idealHits = Math.min(rel.size, k)
  let idcg = 0
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : Math.min(1, dcg / idcg)
}

// Compute all per-question metrics at once.
export function metricsFor(relevant, retrieved, k) {
  return {
    recall_at_k: recallAtK(relevant, retrieved, k),
    precision_at_k: precisionAtK(relevant, retrieved, k),
    mrr: mrr(relevant, retrieved, k),
    hit_rate_at_k: hitRateAtK(relevant, retrieved, k),
    ndcg_at_k: ndcgAtK(relevant, retrieved, k)
  }
}

// Arithmetic mean of a numeric field across per-question metric objects.
export function mean(values) {
  if (values.length === 0) return 0
  let s = 0
  for (const v of values) s += v
  return s / values.length
}

// Rounding helpers (banker-free, standard half-up via toFixed semantics).
export function round(value, dp) {
  const f = Math.pow(10, dp)
  // Add a tiny epsilon to counter binary-float representation of exact halves
  // (e.g. 0.005) so rounding is stable and deterministic across runs/platforms.
  return Math.round((value + Number.EPSILON) * f) / f
}
