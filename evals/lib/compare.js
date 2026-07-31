import path from 'path'
import fs from 'fs/promises'
import { loadConfig, METRIC_KEYS, METRIC_LABEL } from './config.js'
import { readRuns, sortByRunId } from './store.js'
import { round } from './metrics.js'

// Markdown can't be searched/lazy-loaded, so its per-question tables are capped
// to the top-N most-attention-worthy (regressed/weakest first). Full set lives
// in compare.html / result.jsonl.
const MD_TOP_N = 50

async function collectRuns(cfg) {
  return sortByRunId(await readRuns(cfg))
}

// Inline browser script for the per-question section: builds table rows from the
// embedded JSON blob, supports search + column sort, and lazily renders a row's
// 5 line charts only when expanded. Plain string so the page stays self-contained.
const PQ_SCRIPT = `
(function(){
  var blob = JSON.parse(document.getElementById('pq-data').textContent);
  var KEYS = blob.metricKeys, LBL = blob.metricLabels, GATES = blob.gates;
  var RUNS = blob.runShorts, K = blob.k, DATA = blob.data;
  var tbody = document.querySelector('#pq-table tbody');
  var search = document.getElementById('pq-search');
  var countEl = document.getElementById('pq-count');
  var sortKey = null, sortDir = 1; // null = default order (already regressed-first)

  function fmt(v){ return (v==null)?'—':v.toFixed(2); }
  function deltaStr(d){ if(d==null) return ''; var s = d>0?'▲':d<0?'▼':'═'; return ' '+s+(d>0?'+':d<0?'−':'')+Math.abs(d).toFixed(2); }

  // Lazy chart: mirrors the server-side lineChartSvg geometry.
  function chartSvg(key, vals){
    var W=520,H=210,m={top:20,right:16,bottom:34,left:38},iw=W-m.left-m.right,ih=H-m.top-m.bottom;
    var n=vals.length, gate=GATES[key];
    function x(i){ return m.left+(n<=1?iw/2:(i/(n-1))*iw); }
    function y(v){ return m.top+(1-v)*ih; }
    var out='<svg viewBox="0 0 '+W+' '+H+'" class="pqc">';
    [0,0.25,0.5,0.75,1].forEach(function(g){ var yy=y(g).toFixed(1);
      out+='<line class="grid" x1="'+m.left+'" y1="'+yy+'" x2="'+(m.left+iw)+'" y2="'+yy+'"/>';
      out+='<text class="axis" x="'+(m.left-6)+'" y="'+(y(g)+3).toFixed(1)+'" text-anchor="end">'+g.toFixed(2)+'</text>';
    });
    if(gate!=null){ out+='<line class="gate" x1="'+m.left+'" y1="'+y(gate).toFixed(1)+'" x2="'+(m.left+iw)+'" y2="'+y(gate).toFixed(1)+'"/>';
      out+='<text class="gatelabel" x="'+(m.left+iw)+'" y="'+(y(gate)-4).toFixed(1)+'" text-anchor="end">gate ≥ '+gate.toFixed(2)+'</text>'; }
    var d=vals.map(function(v,i){ return (i?'L':'M')+x(i).toFixed(1)+','+y(v).toFixed(1); }).join(' ');
    out+='<path class="series" d="'+d+'" fill="none"/>';
    vals.forEach(function(v,i){ var below=gate!=null&&v<gate;
      out+='<circle class="dot'+(below?' below':'')+'" cx="'+x(i).toFixed(1)+'" cy="'+y(v).toFixed(1)+'" r="3"><title>'+RUNS[i]+': '+v.toFixed(3)+'</title></circle>'; });
    vals.forEach(function(v,i){ if(n>1&&i!==0&&i!==n-1) return;
      out+='<text class="axis" x="'+x(i).toFixed(1)+'" y="'+(H-m.bottom+14)+'" text-anchor="middle">'+RUNS[i]+'</text>'; });
    out+='</svg>';
    var avg=vals.reduce(function(s,v){return s+v;},0)/(n||1);
    var gated = gate!=null;
    return '<figure class="pqchart"><figcaption>'+LBL[key]+'@K'
      +(gated?' <span class="tag">gated</span>':' <span class="tag muted">reported</span>')
      +'<span class="chart-avg">avg '+avg.toFixed(2)+'</span></figcaption>'+out+'</figure>';
  }

  function render(list){
    tbody.innerHTML='';
    countEl.textContent = list.length + (list.length===DATA.length?'':' / '+DATA.length) + ' shown';
    var frag=document.createDocumentFragment();
    list.forEach(function(q){
      var tr=document.createElement('tr'); tr.className='pq-row';
      var cells='<td class="mono">'+q.id+'</td><td class="q-cell">'+q.question.replace(/</g,'&lt;')+'</td>';
      KEYS.forEach(function(k){ cells+='<td>'+fmt(q.avg[k])+'<span class="d">'+deltaStr(q.delta[k])+'</span></td>'; });
      tr.innerHTML=cells;
      var det=document.createElement('tr'); det.className='pq-detail'; det.style.display='none';
      det.innerHTML='<td colspan="'+(2+KEYS.length)+'"><div class="pq-charts"></div></td>';
      var built=false;
      tr.addEventListener('click', function(){
        var open = det.style.display!=='none';
        det.style.display = open?'none':'table-row';
        tr.classList.toggle('open', !open);
        if(!open && !built){ det.querySelector('.pq-charts').innerHTML = KEYS.map(function(k){return chartSvg(k,q.series[k]);}).join(''); built=true; }
      });
      frag.appendChild(tr); frag.appendChild(det);
    });
    tbody.appendChild(frag);
  }

  function apply(){
    var term=search.value.trim().toLowerCase();
    var list=DATA.filter(function(q){ return !term || q.id.toLowerCase().indexOf(term)>=0 || q.question.toLowerCase().indexOf(term)>=0; });
    if(sortKey){ list=list.slice().sort(function(a,b){
      var av,bv;
      if(sortKey==='id'){ av=a.id; bv=b.id; return (av<bv?-1:av>bv?1:0)*sortDir; }
      if(sortKey==='question'){ av=a.question; bv=b.question; return (av<bv?-1:av>bv?1:0)*sortDir; }
      av=a.avg[sortKey]; bv=b.avg[sortKey]; return (av-bv)*sortDir;
    }); }
    render(list);
  }

  search.addEventListener('input', apply);
  document.querySelectorAll('#pq-table thead th').forEach(function(th){
    var key = th.getAttribute('data-sort') || th.getAttribute('data-metric');
    if(!key) return;
    th.classList.add('sortable');
    th.addEventListener('click', function(){
      if(sortKey===key){ sortDir=-sortDir; } else { sortKey=key; sortDir = (key==='id'||key==='question')?1:-1; }
      document.querySelectorAll('#pq-table thead th').forEach(function(t){t.classList.remove('asc','desc');});
      th.classList.add(sortDir>0?'asc':'desc');
      apply();
    });
  });
  render(DATA); // default: already sorted regressed-first
  countEl.textContent = DATA.length + ' shown';
})();
`

// ---- tiny SVG line chart (no dependencies) --------------------------------
function lineChartSvg({ key, label, points, gate, avg }) {
  const W = 680
  const H = 260
  const m = { top: 24, right: 20, bottom: 46, left: 44 }
  const iw = W - m.left - m.right
  const ih = H - m.top - m.bottom
  const n = points.length

  // y spans the metric's natural [0,1] range so charts are comparable.
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

  // x ticks: first, last, and every ~(n/6)th to avoid crowding
  const step = Math.max(1, Math.ceil(n / 6))
  const xticks = points
    .map((p, i) => {
      if (n > 1 && i !== 0 && i !== n - 1 && i % step !== 0) return ''
      return `<text class="axis xtick" x="${x(i).toFixed(1)}" y="${H - m.bottom + 16}" text-anchor="middle">${p.runShort}</text>`
    })
    .join('')

  return `<figure class="chart">
  <figcaption>${label}${gate !== null && gate !== undefined ? ' <span class="tag">gated</span>' : ' <span class="tag muted">reported</span>'}<span class="chart-avg">avg ${avg.toFixed(2)} across ${n} run${n === 1 ? '' : 's'}</span></figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}, average ${avg.toFixed(2)} across ${n} runs">
    ${grid}
    ${gateLine}
    <path class="series" d="${linePath}" fill="none"/>
    ${dots}
    ${xticks}
  </svg>
</figure>`
}

// Per-question section, built to scale to 1000+ questions: ONE searchable /
// sortable table + a compact JSON blob; a row's 5 charts render lazily (in JS)
// only when expanded. No external deps; embedded data is fixed → deterministic.
function renderPerQuestionSection(runs) {
  // Question order + latest text.
  const order = []
  const seen = new Set()
  const textById = new Map()
  for (const r of runs) {
    for (const q of r.per_question || []) {
      if (!seen.has(q.id)) {
        seen.add(q.id)
        order.push(q.id)
      }
      textById.set(q.id, q.question)
    }
  }
  if (order.length === 0) return ''

  const baseById = new Map((runs[0].per_question || []).map(q => [q.id, q.metrics])) // oldest run = baseline for Δ
  const runShorts = runs.map(shortRunId)
  const gates = {}
  for (const key of METRIC_KEYS) gates[key] = runs[runs.length - 1].aggregate[key].gate ?? null

  // Per-question model: series per metric + avg + delta-vs-baseline.
  const data = order.map(id => {
    const series = {}
    const avg = {}
    const delta = {}
    for (const key of METRIC_KEYS) {
      const vals = []
      for (const r of runs) {
        const q = (r.per_question || []).find(x => x.id === id)
        if (q) vals.push(round(q.metrics[key], 3))
      }
      series[key] = vals
      const a = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0
      avg[key] = round(a, 3)
      const b = baseById.get(id)
      const last = vals.length ? vals[vals.length - 1] : 0
      delta[key] = b ? round(last - b[key], 3) : null
    }
    return { id, question: textById.get(id) || '', series, avg, delta }
  })

  // Default sort: regressed / weakest first — biggest MRR drop, then lowest MRR avg.
  data.sort((a, b) => {
    const da = a.delta.mrr === null ? 0 : a.delta.mrr
    const db = b.delta.mrr === null ? 0 : b.delta.mrr
    if (da !== db) return da - db // most negative (biggest drop) first
    if (a.avg.mrr !== b.avg.mrr) return a.avg.mrr - b.avg.mrr // lowest MRR first
    return a.id < b.id ? -1 : 1
  })

  const headCells = METRIC_KEYS.map(k => `<th data-metric="${k}">${METRIC_LABEL[k]}</th>`).join('')

  const blob = { runShorts, gates, k: runs[runs.length - 1].config.k, metricKeys: METRIC_KEYS, metricLabels: METRIC_LABEL, data }

  return `<h2 class="section-h">Per-question metric trends
    <span class="section-hint">${data.length} questions · sorted by MRR drop then lowest MRR · click a row for its charts</span>
  </h2>
  <div class="pq-controls">
    <input id="pq-search" type="search" placeholder="filter ${data.length} questions by id or text…" autocomplete="off"/>
    <span id="pq-count" class="pq-count"></span>
  </div>
  <table id="pq-table">
    <thead><tr><th data-sort="id">id</th><th data-sort="question">question</th>${headCells}</tr></thead>
    <tbody></tbody>
  </table>
  <script id="pq-data" type="application/json">${JSON.stringify(blob).replace(/</g, '\\u003c')}</script>
  <script>${PQ_SCRIPT}</script>`
}

// short run id for chart tooltips / x-axis (time-of-day)
function shortRunId(r) {
  return r.run_id.replace(/T/, ' ').replace(/Z.*$/, '').slice(5)
}

// A click-to-expand card for one run: summary row + aggregate table +
// per-question table (all 5 metrics). Native <details> — no JS.
function renderRunDetails(r) {
  const statusIcon = s => (s === 'pass' ? '✅' : s === 'fail' ? '❌' : 'ℹ️')
  const arrow = d => (d === null || d === undefined ? '' : d > 0 ? '▲' : d < 0 ? '▼' : '═')
  const gateStr = g => (g === null || g === undefined ? '—' : `≥ ${g.toFixed(2)}`)

  const summaryCells = METRIC_KEYS.map(k => `<span class="sum-metric">${METRIC_LABEL[k]} ${r.aggregate[k].value.toFixed(2)}</span>`).join('')
  const res = r.overall_status === 'fail' ? '❌ FAIL' : '✅ PASS'

  const aggRows = METRIC_KEYS.map(k => {
    const a = r.aggregate[k]
    const delta = a.delta === null || a.delta === undefined ? '—' : `${arrow(a.delta)} ${a.delta > 0 ? '+' : a.delta < 0 ? '−' : ''}${Math.abs(a.delta).toFixed(2)}`
    const base = a.baseline === null || a.baseline === undefined ? '—' : a.baseline.toFixed(2)
    return `<tr><td>${METRIC_LABEL[k]}@${r.config.k}</td><td>${a.value.toFixed(2)}</td><td>${delta}</td><td>${base}</td><td>${gateStr(a.gate)}</td><td>${statusIcon(a.status)}</td></tr>`
  }).join('')

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

  // per-question retrieval detail: what search_docs returned, ranked, hits marked
  const retrievalSection = (r.per_question || []).length
    ? `<div class="rd-sub">Retrieved results per question <span class="muted">(rank order; ✅ = relevant, ✗ = not)</span></div>
       ${(r.per_question).map(q => {
        const relevant = new Set(q.relevant_doc_ids || [])
        const question = (q.question || '').replace(/</g, '&lt;')
        const relList = (q.relevant_doc_ids || []).map(id => `<li class="mono">${id}</li>`).join('')
        const retList = (q.retrieved_ids || []).map((id, i) => {
          const hit = relevant.has(id)
          return `<li class="mono ${hit ? 'hit' : 'miss'}">${i + 1}. ${hit ? '✅' : '✗'} ${id}</li>`
        }).join('')
        return `<details class="q-retr">
  <summary><span class="mono">${q.id}</span> <span class="q-cell">${question}</span></summary>
  <div class="q-retr-body">
    <div class="rd-sub2">relevant (${(q.relevant_doc_ids || []).length})</div>
    <ul class="id-list">${relList}</ul>
    <div class="rd-sub2">retrieved top-${r.config.k}</div>
    <ul class="id-list">${retList || '<li class="muted">(none)</li>'}</ul>
  </div>
</details>`
      }).join('')}`
    : ''

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
    ${retrievalSection}
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
    const avg = points.length ? points.reduce((s, p) => s + p.value, 0) / points.length : 0
    return lineChartSvg({ key, label: `${METRIC_LABEL[key]}@K`, points, gate, avg })
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
  .chart-avg { float:right; font-size:11px; font-weight:600; color:var(--ink2); font-variant-numeric:tabular-nums; }
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
  .section-hint { font-weight:400; color:var(--muted); font-size:12px; }
  .pq-controls { padding:0 28px 8px; display:flex; align-items:center; gap:12px; }
  #pq-search { flex:0 0 360px; max-width:60%; padding:6px 10px; font-size:13px; border-radius:6px;
    border:1px solid var(--border); background:var(--surface); color:var(--ink); }
  .pq-count { font-size:12px; color:var(--muted); }
  #pq-table { border-collapse:collapse; width:calc(100% - 56px); margin:0 28px 28px; font-size:12px; }
  #pq-table th, #pq-table td { text-align:right; padding:5px 9px; border-bottom:1px solid var(--grid); font-variant-numeric:tabular-nums; }
  #pq-table th:first-child, #pq-table td:first-child, #pq-table th.q-cell, #pq-table td.q-cell { text-align:left; }
  #pq-table thead th { color:var(--ink2); border-bottom:1.5px solid var(--axis); font-weight:600; position:sticky; top:0; background:var(--page); }
  #pq-table th.sortable { cursor:pointer; user-select:none; }
  #pq-table th.sortable:hover { color:var(--ink); }
  #pq-table th.asc::after { content:" ▲"; color:var(--muted); }
  #pq-table th.desc::after { content:" ▼"; color:var(--muted); }
  #pq-table td.q-cell { color:var(--ink2); max-width:520px; white-space:normal; }
  #pq-table td .d { color:var(--muted); font-size:11px; }
  .pq-row { cursor:pointer; }
  .pq-row:hover { background:var(--surface); }
  .pq-row.open { background:var(--surface); font-weight:600; }
  .pq-detail > td { background:var(--surface); padding:8px 14px 14px; }
  .pq-charts { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:12px; }
  .pqchart { margin:0; }
  .pqchart figcaption { font-size:12px; font-weight:600; margin:2px 2px 4px; }
  svg.pqc { width:100%; height:auto; display:block; }
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
  .rd-sub2 { font-size:11px; color:var(--muted); font-weight:600; margin:6px 0 2px; }
  .q-retr { border-top:1px solid var(--grid); }
  .q-retr > summary { cursor:pointer; padding:5px 2px; font-size:12px; list-style:none; }
  .q-retr > summary::-webkit-details-marker { display:none; }
  .q-retr > summary::before { content:"▸"; color:var(--muted); display:inline-block; width:10px; }
  .q-retr[open] > summary::before { content:"▾"; }
  .q-retr-body { padding:2px 0 8px 14px; }
  .id-list { list-style:none; margin:0 0 4px; padding:0; }
  .id-list li { font-size:11px; padding:1px 0; word-break:break-all; }
  .id-list li.hit { color:var(--ink); }
  .id-list li.miss { color:var(--ink2); }
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

  // 2) Per-question: one compact avg+Δ table, regressed/weakest-first, capped to MD_TOP_N.
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
    const baseById = new Map((runs[0].per_question || []).map(q => [q.id, q.metrics]))
    // avg + delta-vs-baseline per question per metric
    const rows = qOrder.map(id => {
      const avg = {}
      const delta = {}
      for (const key of METRIC_KEYS) {
        const vals = []
        for (const r of runs) {
          const q = (r.per_question || []).find(x => x.id === id)
          if (q) vals.push(q.metrics[key])
        }
        avg[key] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0
        const b = baseById.get(id)
        const last = vals.length ? vals[vals.length - 1] : 0
        delta[key] = b ? last - b[key] : null
      }
      return { id, question: textById.get(id) || '', avg, delta }
    })
    rows.sort((a, b) => {
      const da = a.delta.mrr === null ? 0 : a.delta.mrr
      const db = b.delta.mrr === null ? 0 : b.delta.mrr
      if (da !== db) return da - db
      if (a.avg.mrr !== b.avg.mrr) return a.avg.mrr - b.avg.mrr
      return a.id < b.id ? -1 : 1
    })
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
      const dz = d === null ? '' : d > 0 ? ` (▲+${d.toFixed(2)})` : d < 0 ? ` (▼−${Math.abs(d).toFixed(2)})` : ''
      return `${avg.toFixed(2)}${dz}`
    }
    L.push(`| id | question | ${METRIC_KEYS.map(k => METRIC_LABEL[k]).join(' | ')} |`)
    L.push(`|---|---|${METRIC_KEYS.map(() => '--:').join('|')}|`)
    for (const row of shown) {
      const cells = METRIC_KEYS.map(k => fmtCell(row.avg[k], row.delta[k])).join(' | ')
      const text = (row.question || '').replace(/\|/g, '\\|')
      L.push(`| ${row.id} | ${text} | ${cells} |`)
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
      const pq = r.per_question
      const shownPq = pq.slice(0, MD_TOP_N)
      if (pq.length > shownPq.length) {
        L.push(`_First ${shownPq.length} of ${pq.length} questions (full detail in \`compare.html\` / \`result.jsonl\`)._`)
        L.push('')
      }
      L.push(`| id | question | ${METRIC_KEYS.map(k => METRIC_LABEL[k]).join(' | ')} | hit ranks |`)
      L.push(`|---|---|${METRIC_KEYS.map(() => '--:').join('|')}|:--|`)
      for (const q of shownPq) {
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
