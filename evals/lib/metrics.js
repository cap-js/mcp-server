// Pure-arithmetic retrieval metrics, binary relevance. Deterministic: no I/O,
// randomness, LLM, or wall-clock.
//
// `retrieved` is the raw ranked slots search_docs returned (best first).
// Duplicates are KEPT — the eval scores the tool's real output, not a cleaned
// copy, so a page filling 3 of the K slots counts as 3 slots.
//
// `relevant` is a list of "relevance groups". Each group is one relevant
// answer; a group may hold multiple alternate doc ids and ANY one of them
// satisfies the group. A group counts once toward recall / nDCG regardless of
// how many alternates the retriever surfaces. A bare string entry is
// tolerated as shorthand for a singleton group so callers that still hand in
// a flat id list keep working.

function topK(retrieved, k) {
  return retrieved.slice(0, k)
}

// Build Map<docId, groupIndex>. Empty relevant → empty map.
function indexGroups(relevant) {
  const idx = new Map()
  for (let g = 0; g < relevant.length; g++) {
    const entry = relevant[g]
    const ids = Array.isArray(entry) ? entry : [entry]
    for (const id of ids) idx.set(id, g)
  }
  return idx
}

// 1-based ranks (within top-K) at which any relevant group is matched, per slot.
export function relevantHitsAtRank(relevant, retrieved, k) {
  const idx = indexGroups(relevant)
  const ranks = []
  const top = topK(retrieved, k)
  for (let i = 0; i < top.length; i++) {
    for (const id of top[i].ids) {
      if (idx.has(id)) {
        ranks.push(i + 1)
        break
      }
    }
  }
  return ranks
}

// Distinct relevant groups found / total groups (a group matched by several
// slots still counts once). ∈ [0,1].
export function recallAtK(relevant, retrieved, k) {
  if (relevant.length === 0) return 0
  const idx = indexGroups(relevant)
  const top = topK(retrieved, k)
  const found = new Set()
  for (const t of top) {
    for (const id of t.ids) {
      if (idx.has(id)) found.add(idx.get(id))
    }
  }
  return found.size / relevant.length
}

// Distinct relevant groups found in top-K / k. Each OR-group counts at most
// once regardless of how many of its alternates (or duplicate slots) show up.
// Signals "how much of the top-K is unique relevant answers", complementing
// recall which normalises by the size of the relevant set.
export function precisionAtK(relevant, retrieved, k) {
  if (k <= 0) return 0
  const idx = indexGroups(relevant)
  const top = topK(retrieved, k)
  const credited = new Set()
  for (const t of top) {
    for (const id of t.ids) {
      const g = idx.get(id)
      if (g !== undefined) credited.add(g)
    }
  }
  return credited.size / k
}

export function mrr(relevant, retrieved, k) {
  const idx = indexGroups(relevant)
  const top = topK(retrieved, k)
  for (let i = 0; i < top.length; i++) {
    for (const id of top[i].ids) if (idx.has(id)) return 1 / (i + 1)
  }
  return 0
}

export function hitRateAtK(relevant, retrieved, k) {
  const idx = indexGroups(relevant)
  const top = topK(retrieved, k)
  for (const t of top) {
    for (const id of t.ids) if (idx.has(id)) return 1
  }
  return 0
}

// nDCG over the top-K ranking. Each DISTINCT relevant group is credited once,
// at its best rank, so duplicate slots (or two alternates in the same group)
// can't inflate DCG past the ideal and mask a bad ordering. Ideal DCG packs
// the distinct groups at the top. ∈ [0,1].
export function ndcgAtK(relevant, retrieved, k) {
  if (relevant.length === 0) return 0
  const idx = indexGroups(relevant)
  const top = topK(retrieved, k)
  let dcg = 0
  const credited = new Set()
  for (let i = 0; i < top.length; i++) {
    for (const id of top[i].ids) {
      const g = idx.get(id)
      if (g !== undefined && !credited.has(g)) {
        credited.add(g)
        dcg += 1 / Math.log2(i + 2) // rank i+1 → 1/log2(i+2)
      }
    }
  }
  const idealHits = Math.min(relevant.length, k)
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
