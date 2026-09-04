import { metricsFor, relevantHitsAtRank, mean, round } from './metrics.js'
import { METRIC_KEYS } from './config.js'

// Normalise an authored relevant_doc_ids list into groups (string[][]). A
// bare string entry becomes a one-element group; an array entry stays as-is.
// Any match inside a group satisfies that group for retrieval scoring.
export function normalizeRelevant(relevant_doc_ids) {
  return relevant_doc_ids.map(entry => (Array.isArray(entry) ? entry : [entry]))
}

// Structural validation of the golden set. Returns human-readable problem
// strings ([] = valid); catches malformed labels that would crash the run or
// silently skew scoring.
export function validateGolden(questions) {
  const problems = []
  const seenIds = new Set()
  questions.forEach((q, i) => {
    const where = q && q.id ? `question "${q.id}"` : `question #${i + 1}`
    if (!q || typeof q !== 'object') {
      problems.push(`${where}: not an object`)
      return
    }
    if (typeof q.id !== 'string' || !q.id) problems.push(`${where}: missing string "id"`)
    else if (seenIds.has(q.id)) problems.push(`${where}: duplicate id`)
    else seenIds.add(q.id)
    if (typeof q.question !== 'string' || !q.question.trim()) problems.push(`${where}: missing non-empty "question"`)
    if (!Array.isArray(q.relevant_doc_ids)) problems.push(`${where}: "relevant_doc_ids" must be an array`)
    else if (q.relevant_doc_ids.length === 0) problems.push(`${where}: "relevant_doc_ids" is empty (no ground truth)`)
    else {
      q.relevant_doc_ids.forEach((entry, j) => {
        const at = `entry #${j + 1}`
        if (Array.isArray(entry)) {
          if (entry.length === 0) problems.push(`${where}: "relevant_doc_ids" ${at} is an empty OR-group`)
          else if (entry.some(id => typeof id !== 'string' || !id)) problems.push(`${where}: "relevant_doc_ids" ${at} contains a non-string/empty id`)
        } else if (typeof entry !== 'string' || !entry) {
          problems.push(`${where}: "relevant_doc_ids" contains a non-string/empty id`)
        }
      })
    }
  })
  return problems
}

// Pre-flight: every relevant_doc_id must exist in the current index. For an
// OR-group, each alternate is checked independently — a stale alternate is
// still worth flagging even if the group has valid siblings.
export function preflight(goldenQuestions, sourceMap) {
  const stale = []
  for (const q of goldenQuestions) {
    for (const entry of q.relevant_doc_ids) {
      const ids = Array.isArray(entry) ? entry : [entry]
      for (const id of ids) {
        if (!sourceMap.some(m => m.source === id)) stale.push({ question: q.id, doc_id: id })
      }
    }
  }
  return stale
}

// Pure core: build the report object (run_id added by the caller).
export function buildReport({ config, perQuestionRaw, baseline, gates }) {
  const k = config.k

  const per_question = perQuestionRaw
    .map(q => {
      const groups = normalizeRelevant(q.relevant_doc_ids)
      const m = metricsFor(groups, q.retrievedIds, k)
      return {
        id: q.id,
        question: q.question,
        relevant_doc_ids: q.relevant_doc_ids,
        retrieved_ids: q.retrievedIds.slice(0, k),
        // Per-slot text snapshot (when provided), so compare needn't re-read the corpus.
        ...(q.retrieved_texts ? { retrieved_texts: q.retrieved_texts.slice(0, k) } : {}),
        relevant_hits_at_rank: relevantHitsAtRank(groups, q.retrievedIds, k),
        metrics: {
          recall_at_k: round(m.recall_at_k, 3),
          precision_at_k: round(m.precision_at_k, 3),
          mrr: round(m.mrr, 3),
          hit_rate_at_k: m.hit_rate_at_k,
          ndcg_at_k: round(m.ndcg_at_k, 3)
        },
        _full: m // full precision for aggregation; stripped before serialize
      }
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // aggregate = mean of full-precision per-question values, rounded to 2 dp
  const aggregate = {}
  const baseAgg = baseline ? baseline.aggregate : null
  const gated_failures = []
  for (const key of METRIC_KEYS) {
    const value = round(mean(per_question.map(q => q._full[key])), 2)
    const gate = key in gates ? gates[key] : null
    const baselineVal = baseAgg && baseAgg[key] != null ? baseAgg[key].value : null
    const delta = baselineVal === null || baselineVal === undefined ? null : round(value - baselineVal, 2)
    let status
    if (gate === null || gate === undefined) status = 'info'
    else if (value >= gate) status = 'pass'
    else {
      status = 'fail'
      gated_failures.push(key)
    }
    aggregate[key] = { value, baseline: baselineVal, delta, gate: gate ?? null, status }
  }

  const overall_status = gated_failures.length > 0 ? 'fail' : 'pass'
  const diagnosis = diagnose(aggregate)

  for (const q of per_question) delete q._full

  return {
    config,
    baseline_run_id: baseline ? baseline.run_id : null,
    aggregate,
    overall_status,
    gated_failures,
    diagnosis,
    per_question
  }
}

// Min delta magnitude to count as a regression — below this is rounding noise on
// a small golden set (aggregates are 2dp).
export const DIAGNOSE_DEADBAND = 0.02

// Diagnosis from aggregate deltas vs baseline. Reports ALL causes past the
// dead-band (not first-match-wins), so a multi-stage regression isn't monocausal.
export function diagnose(aggregate) {
  const d = key => (aggregate[key] ? aggregate[key].delta : null)
  const down = v => v !== null && v < -DIAGNOSE_DEADBAND
  const recall = d('recall_at_k')
  const mrrD = d('mrr')
  const ndcg = d('ndcg_at_k')
  const prec = d('precision_at_k')

  const causes = []
  if (down(recall)) causes.push('recall_down → chunking/embedding regression')
  if (down(mrrD) || down(ndcg)) causes.push('recall_stable_mrr_down → ranking/scoring regression')
  if (down(prec)) causes.push('precision_down → top-K padded with noise')
  return causes.length ? causes.join('; ') : 'no_regression'
}

// run_id is the ONLY nondeterministic value (`rand` is fixed in tests). Full ms
// timestamp so same-second runs sort by execution time, not by the suffix.
export function makeRunId(now = new Date(), rand) {
  const ts = now.toISOString()
  const suffix = rand || Math.random().toString(16).slice(2, 8)
  return `${ts}_${suffix}`
}
