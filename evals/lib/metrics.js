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
    for (const id of top[i].ids) {
      if (rel.has(id)) {
        ranks.push(i + 1)
        break
      }
    }
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
  for (const t of top) {
    for (const id of t.ids) {
      if (rel.has(id)) found.add(id)
    }
  }
  return found.size / rel.size
}

// Relevant slots / k (duplicates count).
export function precisionAtK(relevant, retrieved, k) {
  if (k <= 0) return 0
  const rel = new Set(relevant)
  const top = topK(retrieved, k)
  let hits = 0
  for (const t of top) { 
    for (const id of t.ids) if (rel.has(id)) hits++
  }
  return hits / k
}

export function mrr(relevant, retrieved, k) {
  const rel = new Set(relevant)
  const top = topK(retrieved, k)
  for (let i = 0; i < top.length; i++) {
    for (const id of top[i].ids) if (rel.has(id)) return 1 / (i + 1)
  }
  return 0
}

export function hitRateAtK(relevant, retrieved, k) {
  const rel = new Set(relevant)
  const top = topK(retrieved, k)
  for (const t of top) {
    for (const id of t.ids) if (rel.has(id)) return 1
  }
  return 0
}

// nDCG over the top-K ranking. Each DISTINCT relevant doc is credited once, at
// its best rank, so duplicate slots can't inflate DCG past the ideal and mask a
// bad ordering. Ideal DCG packs the distinct relevant docs at the top. ∈ [0,1].
export function ndcgAtK(relevant, retrieved, k) {
  const rel = new Set(relevant)
  if (rel.size === 0) return 0
  const top = topK(retrieved, k)
  let dcg = 0
  const credited = new Set()
  for (let i = 0; i < top.length; i++) {
    for (const id of top[i].ids) {
      if (rel.has(id) && !credited.has(id)) {
        credited.add(id)
        dcg += 1 / Math.log2(i + 2) // rank i+1 → 1/log2(i+2)
      }
    }
  }
  const idealHits = Math.min(rel.size, k)
  let idcg = 0
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : dcg / idcg
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
  // Round on magnitude so negatives round symmetrically with positives (e.g.
  // -0.005 → -0.01, mirroring 0.005 → 0.01). Epsilon counters binary-float
  // representation of exact halves so rounding is stable across platforms.
  const r = Math.sign(value) * Math.round(Math.abs(value) * f + Number.EPSILON) / f
  return r === 0 ? 0 : r // normalise -0 → 0
}
