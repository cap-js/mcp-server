// Pure-arithmetic retrieval metrics. Binary relevance.
// No I/O, no randomness, no LLM, no wall-clock. Deterministic given inputs.
//
// Conventions:
// - `relevant` : array of relevant doc ids (the authored ground truth for a question)
// - `retrieved`: array of retrieved doc ids in RANK ORDER (best first)
// - `k`        : cutoff (top-K)
//
// All functions treat `relevant` as a set. `retrieved` is deduped preserving
// first occurrence before applying the cutoff, so a retriever that emits the same
// id twice can't inflate a hit.

function topK(retrieved, k) {
  const seen = new Set()
  const out = []
  for (const id of retrieved) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= k) break
  }
  return out
}

// 1-based ranks (within top-K) at which a relevant doc appears.
export function relevantHitsAtRank(relevant, retrieved, k) {
  const rel = new Set(relevant)
  const ranks = []
  const top = topK(retrieved, k)
  for (let i = 0; i < top.length; i++) {
    if (rel.has(top[i])) ranks.push(i + 1)
  }
  return ranks
}

export function recallAtK(relevant, retrieved, k) {
  const rel = new Set(relevant)
  if (rel.size === 0) return 0
  const top = topK(retrieved, k)
  let hits = 0
  for (const id of top) if (rel.has(id)) hits++
  return hits / rel.size
}

export function precisionAtK(relevant, retrieved, k) {
  if (k <= 0) return 0
  const rel = new Set(relevant)
  const top = topK(retrieved, k)
  let hits = 0
  for (const id of top) if (rel.has(id)) hits++
  // Divide by k (the intended cutoff), not top.length — a short result list
  // that returns fewer than k docs is penalised, which is correct for P@K.
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

export function ndcgAtK(relevant, retrieved, k) {
  const rel = new Set(relevant)
  if (rel.size === 0) return 0
  const top = topK(retrieved, k)
  let dcg = 0
  for (let i = 0; i < top.length; i++) {
    if (rel.has(top[i])) dcg += 1 / Math.log2(i + 2) // rank i+1 → log2((i+1)+1)
  }
  // Ideal DCG: all relevant docs ranked first, up to k.
  const idealHits = Math.min(rel.size, k)
  let idcg = 0
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : dcg / idcg
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
