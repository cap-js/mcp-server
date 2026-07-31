import { metricsFor, relevantHitsAtRank, mean, round } from './metrics.js'
import { METRIC_KEYS, METRIC_LABEL } from './config.js'

// Pre-flight: every relevant_doc_id must exist in the current index.
export function preflight(goldenQuestions, idSet) {
  const stale = []
  for (const q of goldenQuestions) {
    for (const id of q.relevant_doc_ids) {
      if (!idSet.has(id)) stale.push({ question: q.id, doc_id: id })
    }
  }
  return stale
}

// Pure core: build the report object (run_id added by the caller).
export function buildReport({ config, perQuestionRaw, baseline, gates }) {
  const k = config.k

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

// ----- console rendering -----------------------------------------------------
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

// The 3 weakest questions by ABSOLUTE MRR right now (tie-break by id). When a
// baseline is present, each item is annotated with its change vs baseline (so a
// regression shows as "1.00 → 0.33"; an unchanged weak question shows "= 0.33").
export function worstQuestions(report, baseline) {
  const hasBaseline = report.baseline_run_id !== null && baseline
  const baseById = hasBaseline ? new Map(baseline.per_question.map(q => [q.id, q])) : null
  const k = report.config.k

  const rankStr = ranks => (ranks && ranks[0] ? `rank ${ranks[0]}` : `not in top-${k}`)

  const items = [...report.per_question]
    .sort((a, b) => a.metrics.mrr - b.metrics.mrr || (a.id < b.id ? -1 : 1))
    .slice(0, 3)
    .map(q => {
      const nowMrr = q.metrics.mrr
      const nowRank = q.relevant_hits_at_rank
      let detail
      let regressed = false
      if (baseById) {
        const b = baseById.get(q.id)
        const bMrr = b ? b.metrics.mrr : null
        if (bMrr === null) {
          detail = `MRR ${nowMrr.toFixed(2)} (${rankStr(nowRank)}; not in baseline)`
        } else if (bMrr === nowMrr) {
          detail = `MRR ${nowMrr.toFixed(2)} (${rankStr(nowRank)}; = baseline)`
        } else {
          regressed = bMrr > nowMrr
          const arrow = regressed ? '▼' : '▲'
          detail = `first relevant hit: ${rankStr(b.relevant_hits_at_rank)} → ${rankStr(nowRank)}   (MRR ${bMrr.toFixed(2)} ${arrow} ${nowMrr.toFixed(2)})`
        }
      } else {
        detail = `MRR ${nowMrr.toFixed(2)} (first relevant hit ${rankStr(nowRank)})`
      }
      return { id: q.id, question: q.question, detail, regressed }
    })

  return { noBaseline: !hasBaseline, items }
}

// run_id is the ONLY nondeterministic value; `rand` is fixed in tests.
export function makeRunId(now = new Date(), rand) {
  const ts = now.toISOString().replace(/\.\d+Z$/, 'Z')
  const suffix = rand || Math.random().toString(16).slice(2, 8)
  return `${ts}_${suffix}`
}

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
  L.push('  CAP MCP RAG — Eval Run')
  L.push(`  run_id:         ${run_id}`)
  L.push(`  capire version: ${c.capire_version} (${indexInfo.chunkCount.toLocaleString('en-US')} chunks)`)
  L.push(`  golden set:     ${c.golden_set} (${c.golden_set_size} questions)`)
  L.push(`  K:              ${c.k}`)
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
  L.push(`WEAKEST QUESTIONS (lowest MRR${wq.noBaseline ? ' — no baseline, first run' : ' — change vs baseline'})`)
  if (wq.items.length === 0) {
    L.push('  (golden set is empty)')
  }
  for (const w of wq.items) {
    L.push(`  ${w.id}  "${w.question}"`)
    L.push(`           ${w.detail}`)
  }
  return L.join('\n')
}
