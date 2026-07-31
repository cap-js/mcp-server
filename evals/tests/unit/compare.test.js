import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { compare } from '../../lib/compare.js'

const silentLogger = { log() {}, error() {} }

// Minimal valid report object for a given run_id + metric values.
// `perQuestion` (optional) is an array of { id, question, metrics{...} }.
function fakeReport(run_id, { recall = 1, mrr = 1, precision = 0.4, hit = 1, ndcg = 1, perQuestion = [] } = {}) {
  const agg = (value, gate) => ({ value, baseline: null, delta: null, gate, status: gate === null ? 'info' : value >= gate ? 'pass' : 'fail' })
  return {
    run_id,
    config: { capire_version: '2026.5.0', golden_set: 'g', golden_set_size: 1, k: 5 },
    baseline_run_id: null,
    aggregate: {
      recall_at_k: agg(recall, 0.8),
      mrr: agg(mrr, 0.5),
      precision_at_k: agg(precision, null),
      hit_rate_at_k: agg(hit, 0.8),
      ndcg_at_k: agg(ndcg, null)
    },
    overall_status: recall >= 0.8 && mrr >= 0.5 && hit >= 0.8 ? 'pass' : 'fail',
    gated_failures: [],
    diagnosis: 'no_regression',
    per_question: perQuestion
  }
}

// Build a per-question entry with all five metrics.
function pq(id, question, { recall = 1, precision = 0.4, mrr = 1, hit = 1, ndcg = 1 } = {}) {
  return { id, question, relevant_doc_ids: [], retrieved_ids: [], relevant_hits_at_rank: [], metrics: { recall_at_k: recall, precision_at_k: precision, mrr, hit_rate_at_k: hit, ndcg_at_k: ndcg } }
}

describe('compare tests', () => {
  let tmpDir, runsDir
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-compare-'))
    runsDir = path.join(tmpDir, 'runs')
    await fs.mkdir(runsDir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // Append a run report as a line to result.jsonl (the store format).
  async function writeRun(_folderIgnored, report) {
    const p = path.join(runsDir, 'result.jsonl')
    await fs.appendFile(p, JSON.stringify(report) + '\n')
  }

  const overrides = () => ({ paths: { runsDir } })

  test('no runs → exit 3, no file written', async () => {
    const res = await compare({ overrides: overrides(), logger: silentLogger })
    assert.equal(res.code, 3)
    await assert.rejects(() => fs.access(path.join(runsDir, 'compare.html')))
  })

  test('collects all runs from result.jsonl, writes html', async () => {
    await writeRun(null, fakeReport('2026-07-30T10:00:00Z_aaa'))
    await writeRun(null, fakeReport('2026-07-30T11:00:00Z_bbb', { recall: 0.5 }))
    const res = await compare({ overrides: overrides(), logger: silentLogger })
    assert.equal(res.code, 0)
    assert.equal(res.runs, 2)

    const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
    // one chart per metric, one expandable run-detail card per run
    assert.equal((html.match(/<figure class="chart">/g) || []).length, 5)
    assert.equal((html.match(/<details class="run-detail">/g) || []).length, 2)
    // gated metrics draw a gate line (recall, mrr, hit_rate = 3)
    assert.equal((html.match(/class="gate"/g) || []).length, 3)
  })

  test('md format: writes compare.md with tables (no svg)', async () => {
    await writeRun(null, fakeReport('2026-07-30T10:00:00Z_a', { perQuestion: [pq('cap-001', 'How do I define X?', { mrr: 0.5 })] }))
    const res = await compare({ overrides: { paths: { runsDir }, output: { compareFormat: 'md' } }, logger: silentLogger })
    assert.equal(res.code, 0)
    assert.equal(res.format, 'md')
    assert.ok(res.outPath.endsWith('compare.md'))
    const md = await fs.readFile(path.join(runsDir, 'compare.md'), 'utf8')
    assert.match(md, /^# CAP MCP RAG/)
    assert.ok(md.includes('## Aggregate metrics across runs'))
    assert.ok(md.includes('## Per-question metrics (avg across runs)'))
    assert.ok(md.includes('## Inspect each run'))
    assert.ok(md.includes('cap-001'))
    assert.ok(!md.includes('<svg')) // no charts in markdown
    // small golden set → shows all, no cap note
    assert.ok(md.includes('All 1 question'))
    // html must NOT have been written
    await assert.rejects(() => fs.access(path.join(runsDir, 'compare.html')))
  })

  test('md format: caps the per-question table to top-N for large golden sets', async () => {
    // 120 questions across 2 runs → MD should cap to 50 and say so
    const mk = (rid, seed) => {
      const per = []
      for (let i = 1; i <= 120; i++) {
        per.push(pq('cap-' + String(i).padStart(3, '0'), 'Q' + i, { mrr: ((i + seed) % 10) / 10 }))
      }
      return fakeReport(rid, { perQuestion: per })
    }
    await writeRun(null, mk('2026-07-30T10:00:00Z_a', 0))
    await writeRun(null, mk('2026-07-30T11:00:00Z_b', 2))
    await compare({ overrides: { paths: { runsDir }, output: { compareFormat: 'md' } }, logger: silentLogger })
    const md = await fs.readFile(path.join(runsDir, 'compare.md'), 'utf8')
    assert.ok(md.includes('Showing the 50 most-attention-worthy of 120 questions'))
    // per-question section table rows are capped (count '| cap-' lines in that section)
    const section = md.split('## Per-question metrics (avg across runs)')[1].split('## Inspect each run')[0]
    const rowCount = (section.match(/\n\| cap-/g) || []).length
    assert.equal(rowCount, 50)
  })

  test('run-detail card includes aggregate + per-question tables', async () => {
    const q = pq('cap-001', 'How do I define X?', { recall: 1, mrr: 0.5, precision: 0.4, hit: 1, ndcg: 0.65 })
    await writeRun(null, fakeReport('2026-07-30T10:00:00Z_a', { perQuestion: [q] }))
    await compare({ overrides: overrides(), logger: silentLogger })
    const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
    // one card, two rd-tables (aggregate + per-question)
    assert.equal((html.match(/<details class="run-detail">/g) || []).length, 1)
    assert.equal((html.match(/class="rd-table"/g) || []).length, 2)
    // per-question row present with the question id + its MRR (3dp)
    assert.ok(html.includes('cap-001') && html.includes('How do I define X?'))
    assert.ok(html.includes('0.500')) // per-question MRR at 3dp
  })

  test('runs are ordered chronologically by run_id in the table', async () => {
    // write out of order; expect sorted output
    await writeRun(null, fakeReport('2026-07-30T12:00:00Z_zzz'))
    await writeRun(null, fakeReport('2026-07-30T09:00:00Z_aaa'))
    await compare({ overrides: overrides(), logger: silentLogger })
    const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
    const iEarly = html.indexOf('2026-07-30T09:00:00Z_aaa')
    const iLate = html.indexOf('2026-07-30T12:00:00Z_zzz')
    assert.ok(iEarly < iLate, 'earlier run should appear before later run')
  })

  test('skips corrupt/blank lines in result.jsonl', async () => {
    const p = path.join(runsDir, 'result.jsonl')
    await fs.writeFile(p, JSON.stringify(fakeReport('2026-07-30T10:00:00Z_ok')) + '\n\nnot-json\n')
    const res = await compare({ overrides: overrides(), logger: silentLogger })
    assert.equal(res.runs, 1)
  })

  test('per-question section: searchable table + embedded data blob (scales, lazy charts)', async () => {
    const q1a = pq('cap-001', 'How do I define X?', { mrr: 1 })
    const q2a = pq('cap-002', 'How do I do Y?', { mrr: 0.5 })
    await writeRun(null, fakeReport('2026-07-30T10:00:00Z_a', { perQuestion: [q1a, q2a] }))
    // second run: cap-001 MRR regresses; cap-002 stable
    const q1b = pq('cap-001', 'How do I define X?', { mrr: 0.333 })
    const q2b = pq('cap-002', 'How do I do Y?', { mrr: 0.5 })
    await writeRun(null, fakeReport('2026-07-30T11:00:00Z_b', { perQuestion: [q1b, q2b] }))

    await compare({ overrides: overrides(), logger: silentLogger })
    const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')

    assert.ok(html.includes('Per-question metric trends'))
    // a searchable table + search box (not a chart per question)
    assert.ok(html.includes('id="pq-table"'))
    assert.ok(html.includes('id="pq-search"'))
    // only the 5 overall charts are baked as SVG; per-question charts are lazy (JS)
    assert.equal((html.match(/<figure class="chart">/g) || []).length, 5)
    // the questions live in the embedded JSON data blob, regressed-first
    const m = html.match(/id="pq-data"[^>]*>(.*?)<\/script>/s)
    assert.ok(m, 'pq-data blob present')
    const blob = JSON.parse(m[1].replace(/\\u003c/g, '<'))
    assert.equal(blob.data.length, 2)
    assert.equal(blob.data[0].id, 'cap-001') // biggest MRR drop first
    assert.ok(blob.data[0].question === 'How do I define X?')
  })

  test('per-question section omitted when no run has per_question data', async () => {
    await writeRun('eval-run-x', fakeReport('2026-07-30T10:00:00Z_x')) // per_question: []
    await compare({ overrides: overrides(), logger: silentLogger })
    const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
    assert.ok(!html.includes('Per-question metric trends'))
  })
})
