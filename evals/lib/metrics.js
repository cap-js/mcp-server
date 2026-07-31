// Pure-arithmetic retrieval metrics, binary relevance. Deterministic: no I/O,
// randomness, LLM, or wall-clock.
//
// `retrieved` is the raw ranked slots search_docs returned (best first).
// Duplicates are KEPT — the eval scores the tool's real output, not a cleaned
// copy, so a page filling 3 of the K slots counts as 3 slots.

function topK(retrieved, k) {
  return retrieved.slice(0, k)
}

// 1-based ranks (within top-K) at which a relevant doc appears, per slot.
export function relevantHitsAtRank(relevant, retrieved, k) {
  const rel = new Set(relevant)
  const ranks = []
  const top = topK(retrieved, k)
  for (let i = 0; i < top.length; i++) {
    if (rel.has(top[i])) ranks.push(i + 1)
  }
  return ranks
}

// Distinct relevant docs found / total relevant (a relevant page in several
// slots is still one doc). ∈ [0,1].
export function recallAtK(relevant, retrieved, k) {
  const rel = new Set(relevant)
  if (rel.size === 0) return 0
  const top = topK(retrieved, k)
  const found = new Set()
  for (const id of top) if (rel.has(id)) found.add(id)
  return found.size / rel.size
}

// Relevant slots / k (duplicates count).
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

// nDCG over raw slots: each relevant slot contributes a rank-discounted gain;
// ideal DCG packs the DISTINCT relevant docs at the top, so nDCG ∈ [0,1].
export function ndcgAtK(relevant, retrieved, k) {
  const rel = new Set(relevant)
  if (rel.size === 0) return 0
  const top = topK(retrieved, k)
  let dcg = 0
  for (let i = 0; i < top.length; i++) {
    if (rel.has(top[i])) dcg += 1 / Math.log2(i + 2) // rank i+1 → 1/log2(i+2)
  }
  const idealHits = Math.min(rel.size, k)
  let idcg = 0
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : Math.min(1, dcg / idcg)
}

export function metricsFor(relevant, retrieved, k) {
  return {
    recall_at_k: recallAtK(relevant, retrieved, k),
    precision_at_k: precisionAtK(relevant, retrieved, k),
    mrr: mrr(relevant, retrieved, k),
    hit_rate_at_k: hitRateAtK(relevant, retrieved, k),
    ndcg_at_k: ndcgAtK(relevant, retrieved, k)
  }
}

export function mean(values) {
  if (values.length === 0) return 0
  let s = 0
  for (const v of values) s += v
  return s / values.length
}

export function round(value, dp) {
  const f = Math.pow(10, dp)
  // epsilon counters binary-float representation of exact halves (e.g. 0.005)
  // so rounding is stable across runs/platforms.
  return Math.round((value + Number.EPSILON) * f) / f
}
