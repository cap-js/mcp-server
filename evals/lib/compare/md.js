import { METRIC_KEYS, METRIC_LABEL } from '../config.js'
import { buildPerQuestionModel, runDisplay, statusIcon, gateStr } from './model.js'

// Markdown can't be searched/lazy-loaded, so its per-question tables are capped
// to the top-N most-attention-worthy (regressed/weakest first). Full set lives
// in compare.html / result.jsonl.
const MD_TOP_N = 50

// Escape a cell for a markdown table: backslashes first, then pipes.
function mdCell(text) {
  return (text || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

// ---- markdown compare report (full parity, tables only — no charts) -------
export function renderMarkdownCompare(runs) {
  const L = []
  const first = runs[0].run_id
  const last = runs[runs.length - 1].run_id

  L.push('# CAP MCP RAG — Metric trends across runs')
  L.push('')
  L.push(`${runs.length} run${runs.length === 1 ? '' : 's'} · ${first} → ${last}`)
  L.push('')

  // 1) Aggregate: metric × run matrix
  L.push('## Aggregate metrics across runs')
  L.push('')
  L.push(`| metric | gate | ${runs.map((r) => mdCell(runDisplay(r))).join(' | ')} |`)
  L.push(`|---|:--:|${runs.map(() => '--:').join('|')}|`)
  for (const key of METRIC_KEYS) {
    const gate = runs[runs.length - 1].aggregate[key].gate
    const cells = runs
      .map((r) => {
        const a = r.aggregate[key]
        const flag = a.gate !== null && a.gate !== undefined && a.value < a.gate ? ' ❌' : ''
        return `${a.value.toFixed(2)}${flag}`
      })
      .join(' | ')
    L.push(`| ${METRIC_LABEL[key]}@K | ${gateStr(gate)} | ${cells} |`)
  }
  L.push(
    `| **result** |  | ${runs.map((r) => (r.overall_status === 'fail' ? '❌' : '✅')).join(' | ')} |`
  )
  L.push('')

  // 2) Per-question: one compact avg+Δ table, regressed/weakest-first, capped to MD_TOP_N.
  const { order: qOrder, rows } = buildPerQuestionModel(runs)
  if (qOrder.length) {
    const shown = rows.slice(0, MD_TOP_N)

    L.push('## Per-question metrics (avg across runs)')
    L.push('')
    L.push(
      qOrder.length > shown.length
        ? `Showing the ${shown.length} most-attention-worthy of ${qOrder.length} questions (sorted by MRR drop vs baseline, then lowest MRR). Full per-question detail: open \`compare.html\` or read \`result.jsonl\`.`
        : `All ${qOrder.length} questions (sorted by MRR drop vs baseline, then lowest MRR).`
    )
    L.push('')
    const fmtCell = (avg, d) => {
      const dz =
        d === null
          ? ''
          : d > 0
            ? ` (▲+${d.toFixed(2)})`
            : d < 0
              ? ` (▼−${Math.abs(d).toFixed(2)})`
              : ''
      return `${avg.toFixed(2)}${dz}`
    }
    L.push(`| id | question | ${METRIC_KEYS.map((k) => METRIC_LABEL[k]).join(' | ')} |`)
    L.push(`|---|---|${METRIC_KEYS.map(() => '--:').join('|')}|`)
    for (const row of shown) {
      const cells = METRIC_KEYS.map((k) => fmtCell(row.avg[k], row.delta[k])).join(' | ')
      const text = mdCell(row.question)
      L.push(`| ${row.id} | ${text} | ${cells} |`)
    }
    L.push('')
  }

  // 3) Per-run drill-down: aggregate + per-question tables (newest first)
  L.push('## Inspect each run')
  for (const r of [...runs].reverse()) {
    L.push('')
    const heading =
      r.config && r.config.label ? `${r.config.label} — \`${r.run_id}\`` : `\`${r.run_id}\``
    L.push(`### ${heading} — ${r.overall_status === 'fail' ? '❌ FAIL' : '✅ PASS'}`)
    L.push('')
    L.push(
      `capire ${r.config.capire_version} · K=${r.config.k} · baseline ${r.baseline_run_id ? `\`${r.baseline_run_id}\`` : '—'} · diagnosis: \`${r.diagnosis}\``
    )
    L.push('')
    L.push('| metric | value | Δ vs base | baseline | gate | status |')
    L.push('|---|--:|:--:|--:|:--:|:--:|')
    for (const key of METRIC_KEYS) {
      const a = r.aggregate[key]
      const delta =
        a.delta === null || a.delta === undefined
          ? '—'
          : `${a.delta > 0 ? '+' : a.delta < 0 ? '−' : ''}${Math.abs(a.delta).toFixed(2)}`
      const base = a.baseline === null || a.baseline === undefined ? '—' : a.baseline.toFixed(2)
      L.push(
        `| ${METRIC_LABEL[key]}@${r.config.k} | ${a.value.toFixed(2)} | ${delta} | ${base} | ${gateStr(a.gate)} | ${statusIcon(a.status)} |`
      )
    }
    if ((r.per_question || []).length) {
      L.push('')
      const pq = r.per_question
      const shownPq = pq.slice(0, MD_TOP_N)
      if (pq.length > shownPq.length) {
        L.push(
          `_First ${shownPq.length} of ${pq.length} questions (full detail in \`compare.html\` / \`result.jsonl\`)._`
        )
        L.push('')
      }
      L.push(
        `| id | question | ${METRIC_KEYS.map((k) => METRIC_LABEL[k]).join(' | ')} | hit ranks |`
      )
      L.push(`|---|---|${METRIC_KEYS.map(() => '--:').join('|')}|:--|`)
      for (const q of shownPq) {
        const cells = METRIC_KEYS.map((k) => (q.metrics[k] ?? 0).toFixed(3)).join(' | ')
        const ranks =
          q.relevant_hits_at_rank && q.relevant_hits_at_rank.length
            ? q.relevant_hits_at_rank.join(', ')
            : '—'
        const text = mdCell(q.question)
        L.push(`| ${q.id} | ${text} | ${cells} | ${ranks} |`)
      }
    }
  }
  L.push('')
  return L.join('\n')
}
