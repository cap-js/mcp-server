import { metricsFor, relevantHitsAtRank } from './metrics.js'
import { mean, round } from './util.js'
import { METRIC_KEYS } from './config.js'

// Normalise an authored relevant_doc_ids list into groups (string[][]). A
// bare string entry becomes a one-element group; an array entry stays as-is.
// Any match inside a group satisfies that group for retrieval scoring.
function normalizeRelevant(relevant_doc_ids) {
  return relevant_doc_ids.map((entry) => (Array.isArray(entry) ? entry : [entry]))
}

// Pure core: build the report object (run_id added by the caller).
export function buildReport({ config, perQuestionRaw, baseline, gates }) {
  const k = config.k

  const per_question = perQuestionRaw
    .map((q) => {
      const groups = normalizeRelevant(q.relevant_doc_ids)
      const m = metricsFor(groups, q.retrievedIds, k)
      return {
        id: q.id,
        question: q.question,
        relevant_doc_ids: q.relevant_doc_ids,
        retrieved_ids: q.retrievedIds.slice(0, k),
        relevant_hits_at_rank: relevantHitsAtRank(groups, q.retrievedIds, k),
        metrics: {
          recall_at_k: round(m.recall_at_k, 3),
          mrr: round(m.mrr, 3),
          hit_rate_at_k: m.hit_rate_at_k,
          ndcg_at_k: round(m.ndcg_at_k, 3)
        },
        _full: m // full precision for aggregation; stripped before serialize
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  // aggregate = mean of full-precision per-question values, rounded to 2 dp
  const aggregate = {}
  const baseAgg = baseline ? baseline.aggregate : null
  const gated_failures = []
  for (const key of METRIC_KEYS) {
    const value = round(mean(per_question.map((q) => q._full[key])), 2)
    const gate = key in gates ? gates[key] : null
    const baselineVal = baseAgg && baseAgg[key] != null ? baseAgg[key].value : null
    const delta =
      baselineVal === null || baselineVal === undefined ? null : round(value - baselineVal, 2)
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

// Diagnosis from aggregate deltas vs baseline. A recall drop is attributed to
// retrieval coverage; ranking is diagnosed only when recall is stable.
export function diagnose(aggregate) {
  const d = (key) => (aggregate[key] ? aggregate[key].delta : null)
  const down = (v) => v !== null && v < -DIAGNOSE_DEADBAND
  const recall = d('recall_at_k')
  const mrrD = d('mrr')
  const ndcg = d('ndcg_at_k')

  const causes = []
  if (down(recall)) causes.push('recall_down → chunking/embedding regression')
  if (!down(recall) && (down(mrrD) || down(ndcg)))
    causes.push('recall_stable_mrr_down → ranking/scoring regression')
  return causes.length ? causes.join('; ') : 'no_regression'
}
