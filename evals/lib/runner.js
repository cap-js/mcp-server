import { metricsFor, relevantHitsAtRank, mean, round } from './metrics.js'
import { METRIC_KEYS, METRIC_LABEL } from './config.js'

// ----- pre-flight: every relevant_doc_id must exist in the current index -----
export function preflight(goldenQuestions, idSet) {
  const stale = []
  for (const q of goldenQuestions) {
    for (const id of q.relevant_doc_ids) {
      if (!idSet.has(id)) stale.push({ question: q.id, doc_id: id })
    }
  }
  return stale
}

// ----- pure core: given inputs, produce the report object (no run_id) --------
// perQuestionRaw: [{ id, question, relevant_doc_ids, retrieved_ids }]
// baseline: prior report object or null
// gates: { metric: number|null }
export function buildReport({ config, perQuestionRaw, baseline, gates }) {
  const k = config.k

  // per-question metrics (full precision → round to 3 dp for output)
  const per_question = perQuestionRaw
    .map(q => {
      const m = metricsFor(q.relevant_doc_ids, q.retrieved_ids, k)
      return {
        id: q.id,
        question: q.question,
        relevant_doc_ids: q.relevant_doc_ids,
        retrieved_ids: q.retrieved_ids.slice(0, k),
        relevant_hits_at_rank: relevantHitsAtRank(q.relevant_doc_ids, q.retrieved_ids, k),
        metrics: {
          recall_at_k: round(m.recall_at_k, 3),
          precision_at_k: round(m.precision_at_k, 3),
          mrr: round(m.mrr, 3),
          hit_rate_at_k: m.hit_rate_at_k,
          ndcg_at_k: round(m.ndcg_at_k, 3)
        },
        _full: m // internal, for aggregation; stripped before serialize
      }
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) // deterministic order

  // aggregate (mean of FULL-precision per-question values, rounded to 2 dp)
  const aggregate = {}
  const baseAgg = baseline ? baseline.aggregate : null
  const gated_failures = []
  for (const key of METRIC_KEYS) {
    const value = round(mean(per_question.map(q => q._full[key])), 2)
    const gate = key in gates ? gates[key] : null
    const baselineVal = baseAgg && baseAgg[key] ? baseAgg[key].value : null
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

  // strip internal field
  for (const q of per_question) delete q._full

  return {
    deterministic: true,
    config,
    baseline_run_id: baseline ? baseline.run_id : null,
    aggregate,
    overall_status,
    gated_failures,
    diagnosis,
    per_question
  }
}

// diagnosis rules (first match wins), driven by aggregate deltas vs baseline.
export function diagnose(aggregate) {
  const d = key => (aggregate[key] ? aggregate[key].delta : null)
  const down = v => v !== null && v < 0
  const recall = d('recall_at_k')
  const mrrD = d('mrr')
  const ndcg = d('ndcg_at_k')
  const prec = d('precision_at_k')

  if (down(recall)) return 'recall_down → chunking/embedding regression'
  if (down(mrrD) || down(ndcg)) return 'recall_stable_mrr_down → ranking/scoring regression'
  if (down(prec)) return 'precision_down → top-K padded with noise'
  return 'no_regression'
}

// ----- console rendering (deterministic; run_id/corpus passed in) ------------
function renderMetricRow(key, agg, k) {
  const label = `${METRIC_LABEL[key]}@${k}`.padEnd(15)
  const value = agg.value.toFixed(2)
  const arrow = agg.delta === null ? ' ' : agg.delta > 0 ? '▲' : agg.delta < 0 ? '▼' : '═'
  const deltaStr =
    agg.delta === null
      ? '     '
      : agg.delta === 0
        ? ' 0.00'
        : `${agg.delta > 0 ? '+' : '-'}${Math.abs(agg.delta).toFixed(2)}`
  const baseStr = agg.baseline === null ? '(no baseline)  ' : `(baseline ${agg.baseline.toFixed(2)})`
  const gateStr = agg.gate === null ? 'gate  —     ' : `gate ≥${agg.gate.toFixed(2)}`
  let icon
  if (agg.status === 'pass') icon = '✅ PASS'
  else if (agg.status === 'fail') icon = '❌ FAIL'
  else icon = '⚠️ info'
  // spacing tuned to match the spec mock closely
  return `  ${label} ${value}   ${arrow} ${deltaStr}   ${baseStr}   ${gateStr}   ${icon}`
}

function diagnosisProse(report) {
  const code = report.diagnosis
  if (code.startsWith('recall_down')) {
    return ['Recall dropped → relevant chunks are no longer being retrieved.', 'Chunking/embedding regression, not ranking.']
  }
  if (code.startsWith('recall_stable_mrr_down')) {
    return ['Recall stable/up but MRR & nDCG down → relevant chunks still', 'retrieved, ranked LOWER. Ranking/scoring regression, not chunking.']
  }
  if (code.startsWith('precision_down')) {
    return ['Recall & MRR ok but precision down → top-K padded with', 'irrelevant docs (noise).']
  }
  return ['No regression against baseline across gated metrics.']
}

// Top 3 by MRR drop vs baseline; if no baseline, top 3 by lowest absolute MRR.
export function worstQuestions(report, baseline) {
  const hasBaseline = report.baseline_run_id !== null && baseline
  if (!hasBaseline) {
    const items = [...report.per_question]
      .sort((a, b) => a.metrics.mrr - b.metrics.mrr || (a.id < b.id ? -1 : 1))
      .slice(0, 3)
      .map(q => ({
        id: q.id,
        question: q.question,
        detail: `MRR ${q.metrics.mrr.toFixed(2)} (first relevant hit ${q.relevant_hits_at_rank[0] ? 'rank ' + q.relevant_hits_at_rank[0] : 'not in top-K'})`
      }))
    return { noBaseline: true, items }
  }
  const baseById = new Map(baseline.per_question.map(q => [q.id, q]))
  const scored = report.per_question.map(q => {
    const b = baseById.get(q.id)
    const bmrr = b ? b.metrics.mrr : null
    const drop = bmrr === null ? 0 : bmrr - q.metrics.mrr
    return { q, bmrr, drop }
  })
  const items = scored
    .sort((a, b) => b.drop - a.drop || (a.q.id < b.q.id ? -1 : 1))
    .slice(0, 3)
    .map(({ q, bmrr }) => {
      const nowRank = q.relevant_hits_at_rank[0] || null
      const b = baseById.get(q.id)
      const bRank = b && b.relevant_hits_at_rank[0] ? b.relevant_hits_at_rank[0] : null
      let detail
      if (nowRank === null && bRank !== null) {
        detail = `relevant doc fell out of top ${report.config.k}        (Hit-Rate 1 → 0)`
      } else if (bRank !== null && nowRank !== null) {
        detail = `first relevant hit: rank ${bRank} → rank ${nowRank}   (MRR ${bmrr.toFixed(2)} → ${q.metrics.mrr.toFixed(2)})`
      } else {
        detail = `MRR ${(bmrr ?? 0).toFixed(2)} → ${q.metrics.mrr.toFixed(2)}`
      }
      return { id: q.id, question: q.question, detail }
    })
  return { noBaseline: false, items }
}

// ----- run_id (the ONLY nondeterministic value) ------------------------------
export function makeRunId(now = new Date(), rand) {
  const ts = now.toISOString().replace(/\.\d+Z$/, 'Z')
  // short suffix; deterministic when `rand` is provided (tests pass a fixed one)
  const suffix = rand || Math.random().toString(16).slice(2, 8)
  return `${ts}_${suffix}`
}

// A filesystem-safe form of a run_id (drops ':').
export function runIdToFilename(run_id) {
  return `eval-run-${run_id.replace(/[:]/g, '')}.json`
}

// wrapper so worstQuestions gets the baseline object
export function renderConsoleWithBaseline(report, run_id, indexInfo, baseline) {
  const wq = worstQuestions(report, baseline)
  return renderConsoleImpl(report, run_id, indexInfo, wq)
}

function renderConsoleImpl(report, run_id, indexInfo, wq) {
  const c = report.config
  const bar = '════════════════════════════════════════════════════════════════════'
  const rule = '────────────────────────────────────────────────────────────────────'
  const n = report.per_question.length
  const L = []
  L.push(bar)
  L.push('  CAP MCP RAG — Eval Run  (deterministic)')
  L.push(`  run_id:     ${run_id}`)
  L.push(`  corpus:     ${c.corpus_version} (index rev ${c.index_rev}, ${indexInfo.chunkCount.toLocaleString('en-US')} chunks)`)
  L.push(`  embedding:  ${c.embedding_model}`)
  L.push(`  golden set: ${c.golden_set} (${c.golden_set_size} questions)`)
  L.push(`  K:          ${c.k}`)
  L.push(bar)
  L.push('')
  L.push(`RETRIEVAL METRICS (avg over ${n} questions)`)
  for (const key of METRIC_KEYS) L.push(renderMetricRow(key, report.aggregate[key], c.k))
  L.push('')
  L.push(rule)
  L.push('DIAGNOSIS')
  for (const line of diagnosisProse(report)) L.push('  ' + line)
  L.push('')
  if (report.overall_status === 'fail') {
    const names = report.gated_failures.map(k => METRIC_LABEL[k]).join(', ')
    const cnt = report.gated_failures.length
    L.push(`RESULT: ❌ FAILED  (${cnt} gated metric${cnt === 1 ? '' : 's'} below threshold: ${names})  → block merge`)
  } else {
    L.push('RESULT: ✅ PASSED  → all gated metrics within threshold')
  }
  L.push(bar)
  L.push('')
  L.push('WORST QUESTIONS (by MRR drop vs baseline)')
  if (wq.noBaseline) L.push('  (no baseline — first run)')
  for (const w of wq.items) {
    L.push(`  ${w.id}  "${w.question}"`)
    L.push(`           ${w.detail}`)
  }
  return L.join('\n')
}
