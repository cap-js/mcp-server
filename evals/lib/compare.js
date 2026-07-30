import path from 'path'
import fs from 'fs/promises'
import { loadConfig, METRIC_KEYS, METRIC_LABEL } from './config.js'
import { readRuns, sortByRunId } from './store.js'

// All run reports from result.jsonl, sorted chronologically by run_id.
async function collectRuns(cfg) {
  return sortByRunId(await readRuns(cfg))
}

// ---- tiny SVG line chart (no dependencies) --------------------------------
function lineChartSvg({ key, label, points, gate }) {
  const W = 680
  const H = 260
  const m = { top: 24, right: 20, bottom: 46, left: 44 }
  const iw = W - m.left - m.right
  const ih = H - m.top - m.bottom
  const n = points.length

  // y always spans the metric's natural [0,1] range so charts are comparable.
  const yMin = 0
  const yMax = 1
  const x = i => m.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = v => m.top + (1 - (v - yMin) / (yMax - yMin)) * ih

  const gridVals = [0, 0.25, 0.5, 0.75, 1]
  const grid = gridVals
    .map(v => {
      const yy = y(v).toFixed(1)
      return `<line class="grid" x1="${m.left}" y1="${yy}" x2="${m.left + iw}" y2="${yy}"/>` +
        `<text class="axis" x="${m.left - 8}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v.toFixed(2)}</text>`
    })
    .join('')

  const gateLine =
    gate !== null && gate !== undefined
      ? `<line class="gate" x1="${m.left}" y1="${y(gate).toFixed(1)}" x2="${m.left + iw}" y2="${y(gate).toFixed(1)}"/>` +
        `<text class="gatelabel" x="${m.left + iw}" y="${(y(gate) - 5).toFixed(1)}" text-anchor="end">gate ≥ ${gate.toFixed(2)}</text>`
      : ''

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')

  const dots = points
    .map((p, i) => {
      const cx = x(i).toFixed(1)
      const cy = y(p.value).toFixed(1)
      const below = gate !== null && gate !== undefined && p.value < gate
      return `<circle class="dot${below ? ' below' : ''}" cx="${cx}" cy="${cy}" r="4"><title>${p.runShort}\n${label}: ${p.value.toFixed(3)}${below ? '  (below gate)' : ''}</title></circle>`
    })
    .join('')

  // x tick labels: first, last, and every ~ (n/6)th to avoid crowding
  const step = Math.max(1, Math.ceil(n / 6))
  const xticks = points
    .map((p, i) => {
      if (n > 1 && i !== 0 && i !== n - 1 && i % step !== 0) return ''
      return `<text class="axis xtick" x="${x(i).toFixed(1)}" y="${H - m.bottom + 16}" text-anchor="middle">${p.runShort}</text>`
    })
    .join('')

  return `<figure class="chart">
  <figcaption>${label}${gate !== null && gate !== undefined ? ' <span class="tag">gated</span>' : ' <span class="tag muted">reported</span>'}</figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} across ${n} runs">
    ${grid}
    ${gateLine}
    <path class="series" d="${linePath}" fill="none"/>
    ${dots}
    ${xticks}
  </svg>
</figure>`
}

// ---- compact sparkline for one metric of one question across runs ---------
// points: [{ value, runShort }]; gate: number|null. Fixed [0,1] y-range so all
// sparklines are visually comparable. Shows the current (last) value as a label.
function sparklineSvg({ label, points, gate }) {
  const W = 150
  const H = 46
  const m = { top: 6, right: 34, bottom: 6, left: 6 }
  const iw = W - m.left - m.right
  const ih = H - m.top - m.bottom
  const n = points.length
  const x = i => m.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = v => m.top + (1 - v) * ih // v already in [0,1]

  const gateLine =
    gate !== null && gate !== undefined
      ? `<line class="spark-gate" x1="${m.left}" y1="${y(gate).toFixed(1)}" x2="${m.left + iw}" y2="${y(gate).toFixed(1)}"/>`
      : ''
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const dots = points
    .map((p, i) => {
      const below = gate !== null && gate !== undefined && p.value < gate
      return `<circle class="spark-dot${below ? ' below' : ''}" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.2"><title>${p.runShort}: ${p.value.toFixed(3)}</title></circle>`
    })
    .join('')
  const lastVal = points[points.length - 1].value
  const firstVal = points[0].value
  const trend = n < 2 ? '' : lastVal > firstVal ? '▲' : lastVal < firstVal ? '▼' : '═'

  return `<div class="spark">
  <div class="spark-label">${label}</div>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} across runs">
    ${gateLine}
    <path class="spark-line" d="${linePath}" fill="none"/>
    ${dots}
    <text class="spark-val" x="${W - 2}" y="${(H / 2 + 3).toFixed(1)}" text-anchor="end">${trend} ${lastVal.toFixed(2)}</text>
  </svg>
</div>`
}

// Build the per-question section: one block per question id, each with a
// sparkline per metric showing that metric across the runs the question appears in.
function renderPerQuestionSection(runs) {
  // Collect question order + text from the most recent run that has per_question.
  const order = []
  const seen = new Set()
  const textById = new Map()
  for (const r of runs) {
    for (const q of r.per_question || []) {
      if (!seen.has(q.id)) {
        seen.add(q.id)
        order.push(q.id)
      }
      textById.set(q.id, q.question) // last one wins → most recent text
    }
  }
  if (order.length === 0) return ''

  const blocks = order
    .map(id => {
      // Per metric: series across only the runs where this question exists.
      const sparks = METRIC_KEYS.map(key => {
        const points = []
        for (const r of runs) {
          const q = (r.per_question || []).find(x => x.id === id)
          if (q) points.push({ value: q.metrics[key], runShort: shortRunId(r) })
        }
        if (points.length === 0) return ''
        const gate = runs.length ? runs[runs.length - 1].aggregate[key].gate : null
        return sparklineSvg({ label: `${METRIC_LABEL[key]}`, points, gate })
      }).join('\n')
      const text = (textById.get(id) || '').replace(/</g, '&lt;')
      return `<div class="q-block">
  <div class="q-head"><span class="q-id">${id}</span> <span class="q-text">${text}</span></div>
  <div class="q-sparks">${sparks}</div>
</div>`
    })
    .join('\n')

  return `<h2 class="section-h">Per-question metric trends</h2>
<div class="q-grid">
${blocks}
</div>`
}

// short run id for sparkline tooltips (time-of-day)
function shortRunId(r) {
  return r.run_id.replace(/T/, ' ').replace(/Z.*$/, '').slice(5)
}

// A click-to-expand card for one run: summary row + aggregate table +
// per-question table (all 5 metrics). Native <details> — no JS.
function renderRunDetails(r) {
  const statusIcon = s => (s === 'pass' ? '✅' : s === 'fail' ? '❌' : 'ℹ️')
  const arrow = d => (d === null || d === undefined ? '' : d > 0 ? '▲' : d < 0 ? '▼' : '═')
  const gateStr = g => (g === null || g === undefined ? '—' : `≥ ${g.toFixed(2)}`)

  // summary line: run_id + one value per metric + overall result
  const summaryCells = METRIC_KEYS.map(k => `<span class="sum-metric">${METRIC_LABEL[k]} ${r.aggregate[k].value.toFixed(2)}</span>`).join('')
  const res = r.overall_status === 'fail' ? '❌ FAIL' : '✅ PASS'

  // aggregate table
  const aggRows = METRIC_KEYS.map(k => {
    const a = r.aggregate[k]
    const delta = a.delta === null || a.delta === undefined ? '—' : `${arrow(a.delta)} ${a.delta > 0 ? '+' : a.delta < 0 ? '−' : ''}${Math.abs(a.delta).toFixed(2)}`
    const base = a.baseline === null || a.baseline === undefined ? '—' : a.baseline.toFixed(2)
    return `<tr><td>${METRIC_LABEL[k]}@${r.config.k}</td><td>${a.value.toFixed(2)}</td><td>${delta}</td><td>${base}</td><td>${gateStr(a.gate)}</td><td>${statusIcon(a.status)}</td></tr>`
  }).join('')

  // per-question table (all 5 metrics)
  const pqHead = METRIC_KEYS.map(k => `<th>${METRIC_LABEL[k]}</th>`).join('')
  const pqRows = (r.per_question || [])
    .map(q => {
      const cells = METRIC_KEYS.map(k => `<td>${(q.metrics[k] ?? 0).toFixed(3)}</td>`).join('')
      const ranks = q.relevant_hits_at_rank && q.relevant_hits_at_rank.length ? q.relevant_hits_at_rank.join(', ') : '—'
      const question = (q.question || '').replace(/</g, '&lt;')
      return `<tr><td class="mono">${q.id}</td><td class="q-cell">${question}</td>${cells}<td>${ranks}</td></tr>`
    })
    .join('')

  const pqSection = (r.per_question || []).length
    ? `<div class="rd-sub">Per-question metrics</div>
       <table class="rd-table">
         <thead><tr><th>id</th><th>question</th>${pqHead}<th>hit ranks</th></tr></thead>
         <tbody>${pqRows}</tbody>
       </table>`
    : '<div class="rd-sub muted">No per-question data recorded for this run.</div>'

  return `<details class="run-detail">
  <summary><span class="mono">${r.run_id}</span> <span class="sum-metrics">${summaryCells}</span> <span class="sum-res">${res}</span></summary>
  <div class="rd-body">
    <div class="rd-sub">Aggregate metrics · capire ${r.config.capire_version} · K=${r.config.k}${r.baseline_run_id ? ` · baseline <span class="mono">${r.baseline_run_id}</span>` : ' · no baseline'}</div>
    <table class="rd-table">
      <thead><tr><th>metric</th><th>value</th><th>Δ vs base</th><th>baseline</th><th>gate</th><th></th></tr></thead>
      <tbody>${aggRows}</tbody>
    </table>
    <div class="rd-sub">Diagnosis: <code>${r.diagnosis}</code></div>
    ${pqSection}
  </div>
</details>`
}

function renderHtml(runs) {
  // Build per-metric point series.
  const shortId = r => r.run_id.replace(/T/, ' ').replace(/Z.*$/, '').slice(5) // MM-DD HH:MM:SS
  const charts = METRIC_KEYS.map(key => {
    const points = runs.map(r => ({
      value: r.aggregate[key].value,
      runShort: shortId(r),
      runId: r.run_id
    }))
    // gate: take the most recent run's gate for this metric (null = reported only)
    const gate = runs.length ? runs[runs.length - 1].aggregate[key].gate : null
    return lineChartSvg({ key, label: `${METRIC_LABEL[key]}@K`, points, gate })
  }).join('\n')

  // Newest run first so the most recent is easiest to open.
  const runDetails = [...runs].reverse().map(renderRunDetails).join('\n')

  const perQuestion = renderPerQuestionSection(runs)

  const first = runs.length ? runs[0].run_id : '—'
  const last = runs.length ? runs[runs.length - 1].run_id : '—'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>CAP MCP RAG — Metric trends across runs</title>
<style>
  :root {
    color-scheme: light dark;
    --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
    --grid:#e1e0d9; --axis:#c3c2b7; --series:#2a78d6; --gate:#d03b3b; --border:rgba(11,11,11,0.10);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
      --grid:#2c2c2a; --axis:#383835; --series:#3987e5; --gate:#d03b3b; --border:rgba(255,255,255,0.10);
    }
  }
  body { margin:0; background:var(--page); color:var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding:24px 28px 8px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .meta { color:var(--ink2); font-size:13px; }
  .grid-wrap { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:18px; padding:16px 28px 28px; }
  .chart { margin:0; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 12px 6px; }
  .chart figcaption { font-size:13px; font-weight:600; margin:2px 4px 6px; }
  .tag { font-size:10px; font-weight:600; color:var(--gate); border:1px solid var(--gate); border-radius:5px; padding:1px 5px; margin-left:4px; vertical-align:middle; }
  .tag.muted { color:var(--muted); border-color:var(--muted); }
  svg { width:100%; height:auto; display:block; }
  .grid { stroke:var(--grid); stroke-width:1; }
  .axis { fill:var(--muted); font-size:10px; font-variant-numeric:tabular-nums; }
  .series { stroke:var(--series); stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
  .dot { fill:var(--series); stroke:var(--surface); stroke-width:1.5; }
  .dot.below { fill:var(--gate); }
  .gate { stroke:var(--gate); stroke-width:1.5; stroke-dasharray:4 3; }
  .gatelabel { fill:var(--gate); font-size:10px; }
  table { border-collapse:collapse; width:calc(100% - 56px); font-size:12px; }
  th,td { text-align:right; padding:5px 9px; border-bottom:1px solid var(--grid); font-variant-numeric:tabular-nums; }
  th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align:left; }
  .mono { font-family: ui-monospace, monospace; font-size:11px; }
  thead th { color:var(--ink2); border-bottom:1.5px solid var(--axis); }
  .section-h { margin:8px 28px 8px; font-size:14px; }
  .q-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:14px; padding:0 28px 24px; }
  .q-block { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:10px 12px; }
  .q-head { font-size:12px; margin-bottom:6px; }
  .q-id { font-family: ui-monospace, monospace; font-weight:600; }
  .q-text { color:var(--ink2); }
  .q-sparks { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:4px 10px; }
  .spark { }
  .spark-label { font-size:10px; color:var(--muted); font-weight:600; margin-bottom:1px; }
  .spark-line { stroke:var(--series); stroke-width:1.5; stroke-linejoin:round; stroke-linecap:round; }
  .spark-dot { fill:var(--series); }
  .spark-dot.below { fill:var(--gate); }
  .spark-gate { stroke:var(--gate); stroke-width:1; stroke-dasharray:3 2; }
  .spark-val { fill:var(--ink2); font-size:11px; font-variant-numeric:tabular-nums; }
  .section-hint { font-weight:400; color:var(--muted); font-size:12px; }
  .run-list { padding:0 28px 32px; display:flex; flex-direction:column; gap:6px; }
  .run-detail { background:var(--surface); border:1px solid var(--border); border-radius:8px; }
  .run-detail > summary { cursor:pointer; padding:9px 12px; font-size:12px; display:flex; flex-wrap:wrap; align-items:center; gap:10px; list-style:none; }
  .run-detail > summary::-webkit-details-marker { display:none; }
  .run-detail > summary::before { content:"▸"; color:var(--muted); display:inline-block; width:10px; }
  .run-detail[open] > summary::before { content:"▾"; }
  .sum-metrics { display:flex; flex-wrap:wrap; gap:10px; color:var(--ink2); }
  .sum-metric { font-variant-numeric:tabular-nums; }
  .sum-res { margin-left:auto; font-weight:600; }
  .rd-body { padding:4px 14px 14px; }
  .rd-sub { font-size:12px; color:var(--ink2); margin:12px 0 5px; }
  .rd-sub.muted { color:var(--muted); }
  .rd-table { border-collapse:collapse; width:100%; font-size:12px; }
  .rd-table th, .rd-table td { text-align:right; padding:4px 8px; border-bottom:1px solid var(--grid); font-variant-numeric:tabular-nums; }
  .rd-table th:first-child, .rd-table td:first-child, .rd-table th.q-cell, .rd-table td.q-cell { text-align:left; }
  .rd-table td.q-cell { color:var(--ink2); max-width:340px; white-space:normal; }
  .rd-table thead th { color:var(--ink2); border-bottom:1.5px solid var(--axis); font-weight:600; }
  .mono { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<header>
  <h1>CAP MCP RAG — Metric trends across runs</h1>
  <div class="meta">${runs.length} run${runs.length === 1 ? '' : 's'} · ${first} → ${last} · dashed red = gate threshold · red dot = below gate</div>
</header>
<section class="grid-wrap">
${charts}
</section>
${perQuestion}
<h2 class="section-h">Inspect each run <span class="section-hint">(newest first — click to expand aggregate + per-question metrics)</span></h2>
<div class="run-list">
${runDetails}
</div>
</body>
</html>
`
}

// ---- markdown compare report (full parity, tables only — no charts) -------
function renderMarkdownCompare(runs) {
  const shortId = r => r.run_id
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
  L.push(`| metric | gate | ${runs.map(r => shortId(r)).join(' | ')} |`)
  L.push(`|---|:--:|${runs.map(() => '--:').join('|')}|`)
  for (const key of METRIC_KEYS) {
    const gate = runs[runs.length - 1].aggregate[key].gate
    const gateStr = gate === null || gate === undefined ? '—' : `≥ ${gate.toFixed(2)}`
    const cells = runs
      .map(r => {
        const a = r.aggregate[key]
        const flag = a.gate !== null && a.gate !== undefined && a.value < a.gate ? ' ❌' : ''
        return `${a.value.toFixed(2)}${flag}`
      })
      .join(' | ')
    L.push(`| ${METRIC_LABEL[key]}@K | ${gateStr} | ${cells} |`)
  }
  L.push(`| **result** |  | ${runs.map(r => (r.overall_status === 'fail' ? '❌' : '✅')).join(' | ')} |`)
  L.push('')

  // 2) Per-question: one matrix (question × run) per metric
  const qOrder = []
  const seen = new Set()
  const textById = new Map()
  for (const r of runs) {
    for (const q of r.per_question || []) {
      if (!seen.has(q.id)) {
        seen.add(q.id)
        qOrder.push(q.id)
      }
      textById.set(q.id, q.question)
    }
  }
  if (qOrder.length) {
    L.push('## Per-question metrics across runs')
    for (const key of METRIC_KEYS) {
      L.push('')
      L.push(`### ${METRIC_LABEL[key]}@K`)
      L.push('')
      L.push(`| id | question | ${runs.map(r => shortId(r)).join(' | ')} |`)
      L.push(`|---|---|${runs.map(() => '--:').join('|')}|`)
      for (const id of qOrder) {
        const cells = runs
          .map(r => {
            const q = (r.per_question || []).find(x => x.id === id)
            return q ? q.metrics[key].toFixed(3) : '—'
          })
          .join(' | ')
        const text = (textById.get(id) || '').replace(/\|/g, '\\|')
        L.push(`| ${id} | ${text} | ${cells} |`)
      }
    }
    L.push('')
  }

  // 3) Per-run drill-down: aggregate + per-question tables (newest first)
  L.push('## Inspect each run')
  for (const r of [...runs].reverse()) {
    L.push('')
    L.push(`### ${r.run_id} — ${r.overall_status === 'fail' ? '❌ FAIL' : '✅ PASS'}`)
    L.push('')
    L.push(`capire ${r.config.capire_version} · K=${r.config.k} · baseline ${r.baseline_run_id ? `\`${r.baseline_run_id}\`` : '—'} · diagnosis: \`${r.diagnosis}\``)
    L.push('')
    L.push('| metric | value | Δ vs base | baseline | gate | status |')
    L.push('|---|--:|:--:|--:|:--:|:--:|')
    for (const key of METRIC_KEYS) {
      const a = r.aggregate[key]
      const delta = a.delta === null || a.delta === undefined ? '—' : `${a.delta > 0 ? '+' : a.delta < 0 ? '−' : ''}${Math.abs(a.delta).toFixed(2)}`
      const base = a.baseline === null || a.baseline === undefined ? '—' : a.baseline.toFixed(2)
      const gate = a.gate === null || a.gate === undefined ? '—' : `≥ ${a.gate.toFixed(2)}`
      const icon = a.status === 'pass' ? '✅' : a.status === 'fail' ? '❌' : 'ℹ️'
      L.push(`| ${METRIC_LABEL[key]}@${r.config.k} | ${a.value.toFixed(2)} | ${delta} | ${base} | ${gate} | ${icon} |`)
    }
    if ((r.per_question || []).length) {
      L.push('')
      L.push(`| id | question | ${METRIC_KEYS.map(k => METRIC_LABEL[k]).join(' | ')} | hit ranks |`)
      L.push(`|---|---|${METRIC_KEYS.map(() => '--:').join('|')}|:--|`)
      for (const q of r.per_question) {
        const cells = METRIC_KEYS.map(k => (q.metrics[k] ?? 0).toFixed(3)).join(' | ')
        const ranks = q.relevant_hits_at_rank && q.relevant_hits_at_rank.length ? q.relevant_hits_at_rank.join(', ') : '—'
        const text = (q.question || '').replace(/\|/g, '\\|')
        L.push(`| ${q.id} | ${text} | ${cells} | ${ranks} |`)
      }
    }
  }
  L.push('')
  return L.join('\n')
}

export async function compare({ configPath, overrides, outPath, logger = console } = {}) {
  const cfg = await loadConfig({ configPath, overrides })
  const runs = await collectRuns(cfg)

  if (runs.length === 0) {
    logger.error(`No runs found under ${path.relative(process.cwd(), cfg.paths.runsDir)}. Run the eval first.`)
    return { code: 3 }
  }

  const fmt = cfg.output.compareFormat // 'html' | 'md' (validated in config)
  const content = fmt === 'md' ? renderMarkdownCompare(runs) : renderHtml(runs)
  const out = outPath ? path.resolve(outPath) : path.join(cfg.paths.runsDir, `compare.${fmt}`)
  await fs.writeFile(out, content)

  const rel = path.relative(process.cwd(), out)
  logger.log(`Compared ${runs.length} run(s) → ${rel}`)
  if (fmt === 'html') {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    logger.log(`Open it in your browser:  ${opener} ${rel}`)
    logger.log(`  or paste this into the address bar:  file://${out}`)
  } else {
    logger.log(`Open it in your editor/viewer:  ${rel}`)
  }
  return { code: 0, runs: runs.length, outPath: out, format: fmt }
}
