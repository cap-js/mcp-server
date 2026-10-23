import { METRIC_KEYS } from '../config.js'
import { round } from '../util.js'

// Escape text for HTML text content AND quoted attribute values (prevent
// `<` injection and `"`/`'` attribute break-out).
export function escHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Shared cell formatters (HTML + Markdown run-detail tables).
export const statusIcon = (s) => (s === 'pass' ? '✅' : s === 'fail' ? '❌' : 'ℹ️')
export const gateStr = (g) => (g === null || g === undefined ? '—' : `≥ ${g.toFixed(2)}`)

// Shared per-question model for both the HTML and Markdown reports: question
// order + latest text, and one row per question with {id, question, series
// (per-metric values across runs, 3dp), avg, delta-vs-baseline}. Rows are sorted
// regressed/weakest-first (biggest MRR drop, then lowest MRR, then id). Baseline
// = oldest run. Uses a per-run id→metrics Map so lookups aren't O(questions²).
export function buildPerQuestionModel(runs) {
  const order = []
  const seen = new Set()
  const textById = new Map()
  const metricsByRun = runs.map((r) => {
    const m = new Map()
    for (const q of r.per_question || []) {
      if (!seen.has(q.id)) {
        seen.add(q.id)
        order.push(q.id)
      }
      textById.set(q.id, q.question)
      m.set(q.id, q.metrics)
    }
    return m
  })
  const baseMetrics = metricsByRun[0]

  const rows = order.map((id) => {
    const series = {}
    const avg = {}
    const delta = {}
    for (const key of METRIC_KEYS) {
      // One slot per run, aligned by run index; null where the question is
      // absent from that run. Consumers (chart, baseline) skip nulls.
      const vals = []
      for (const m of metricsByRun) {
        const qm = m.get(id)
        vals.push(qm ? round(qm[key], 3) : null)
      }
      series[key] = vals
      const present = vals.filter((v) => v !== null)
      avg[key] = present.length ? round(present.reduce((s, v) => s + v, 0) / present.length, 3) : 0
      const b = baseMetrics.get(id)
      const last = vals.length ? vals[vals.length - 1] : null
      delta[key] = b && last != null ? round(last - b[key], 3) : null
    }
    return { id, question: textById.get(id) || '', series, avg, delta }
  })

  rows.sort((a, b) => {
    const da = a.delta.mrr === null ? 0 : a.delta.mrr
    const db = b.delta.mrr === null ? 0 : b.delta.mrr
    if (da !== db) return da - db // biggest MRR drop first
    if (a.avg.mrr !== b.avg.mrr) return a.avg.mrr - b.avg.mrr // then lowest MRR
    return a.id.localeCompare(b.id, undefined, { numeric: true })
  })

  return { order, textById, rows }
}

// short run id for chart tooltips / x-axis (time-of-day)
export function shortRunId(r) {
  return r.run_id
    .replace(/T/, ' ')
    .replace(/(\.\d+)?Z.*$/, '')
    .slice(5)
}

// Display name for a run: its label if set, else the short timestamp.
export function runDisplay(r) {
  return (r.config && r.config.label) || shortRunId(r)
}

// Truncated label for chart axes (28 chars max + ellipsis). Full label in tooltips.
export function shortLabel(r) {
  const full = runDisplay(r)
  return full.length > 28 ? full.slice(0, 27) + '…' : full
}

// Rank each run for each metric (1 = best). Returns Map<run_id, Map<metric_key, rank>>.
export function buildRanks(runs) {
  const overallValue = (r) => METRIC_KEYS.reduce((s, k) => s + r.aggregate[k].value, 0)
  const ranks = new Map(runs.map((r) => [r.run_id, {}]))
  for (const key of METRIC_KEYS) {
    const sorted = [...runs].sort((a, b) => {
      const vd = b.aggregate[key].value - a.aggregate[key].value
      if (vd !== 0) return vd
      return overallValue(b) - overallValue(a)
    })
    sorted.forEach((r, i) => {
      ranks.get(r.run_id)[key] = i + 1
    })
  }
  return ranks
}
