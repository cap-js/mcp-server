import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { compare, renderDelta } from '../../lib/compare.js'

const silentLogger = { log() {}, error() {} }

function fakeReport(
  run_id,
  { recall = 1, mrr = 1, hit = 1, ndcg = 1, perQuestion = [], label = '' } = {}
) {
  const agg = (value, gate) => ({
    value,
    baseline: null,
    delta: null,
    gate,
    status: gate === null ? 'info' : value >= gate ? 'pass' : 'fail'
  })
  return {
    run_id,
    config: { capire_version: '2026.5.0', golden_set: 'g', golden_set_size: 1, k: 5, label },
    baseline_run_id: null,
    aggregate: {
      recall_at_k: agg(recall, 0.8),
      mrr: agg(mrr, 0.5),
      hit_rate_at_k: agg(hit, 0.8),
      ndcg_at_k: agg(ndcg, null)
    },
    overall_status: recall >= 0.8 && mrr >= 0.5 && hit >= 0.8 ? 'pass' : 'fail',
    gated_failures: [],
    diagnosis: 'no_regression',
    per_question: perQuestion
  }
}

function pq(id, question, { recall = 1, mrr = 1, hit = 1, ndcg = 1 } = {}) {
  return {
    id,
    question,
    relevant_doc_ids: [],
    retrieved_ids: [],
    relevant_hits_at_rank: [],
    metrics: { recall_at_k: recall, mrr, hit_rate_at_k: hit, ndcg_at_k: ndcg }
  }
}

describe('renderDelta', () => {
  test('should render an up arrow with three decimal places for a positive delta', () => {
    assert.equal(renderDelta(1.0, 0.5), ' <span class="d">▲+0.500</span>')
  })

  test('should render a down arrow with three decimal places for a negative delta', () => {
    assert.equal(renderDelta(0.25, 0.5), ' <span class="d">▼−0.250</span>')
  })

  test('should render an empty string when the delta is zero', () => {
    assert.equal(renderDelta(0.5, 0.5), '')
  })

  test('should render an empty string when the baseline is null', () => {
    assert.equal(renderDelta(0.5, null), '')
  })

  describe('side-effects', () => {
    test('should not affect subsequent calls', () => {
      renderDelta(1.0, 0.5)

      const result = renderDelta(0.25, 0.5)

      assert.equal(result, ' <span class="d">▼−0.250</span>')
    })
  })
})

describe('compare', () => {
  let tmpDir, runsDir
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-compare-'))
    runsDir = path.join(tmpDir, 'runs')
    await fs.mkdir(runsDir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeRun(report) {
    const p = path.join(runsDir, 'result.jsonl')
    await fs.appendFile(p, JSON.stringify(report) + '\n')
  }

  const overrides = () => ({ output: { runsDir } })

  describe('when there are no runs', () => {
    test('should exit 3 and not write a compare file', async () => {
      const res = await compare({ overrides: overrides(), logger: silentLogger })

      assert.equal(res.code, 3)
      await assert.rejects(() => fs.access(path.join(runsDir, 'compare.html')))
    })
  })

  describe('with corrupt or malformed data in result.jsonl', () => {
    test('should skip corrupt and blank lines and process valid entries', async () => {
      const p = path.join(runsDir, 'result.jsonl')
      await fs.writeFile(
        p,
        JSON.stringify(fakeReport('2026-07-30T10:00:00Z_ok')) + '\n\nnot-json\n'
      )

      const res = await compare({ overrides: overrides(), logger: silentLogger })

      assert.equal(res.runs, 1)
    })

    test('should skip valid JSON lines that are not run report objects', async () => {
      const p = path.join(runsDir, 'result.jsonl')
      await fs.writeFile(
        p,
        [
          JSON.stringify(fakeReport('2026-07-30T10:00:00Z_ok')),
          '123',
          '"a string"',
          '{"run_id":"x"}',
          '{"aggregate":{}}'
        ].join('\n') + '\n'
      )

      const res = await compare({ overrides: overrides(), logger: silentLogger })

      assert.equal(res.runs, 1)
    })
  })

  describe('html output', () => {
    test('should collect all runs from result.jsonl and write compare.html', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_aaa'))
      await writeRun(fakeReport('2026-07-30T11:00:00Z_bbb', { recall: 0.5 }))

      const res = await compare({ overrides: overrides(), logger: silentLogger })

      assert.equal(res.code, 0)
      assert.equal(res.runs, 2)
      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.equal((html.match(/<figure class="chart">/g) || []).length, 4)
      assert.equal((html.match(/<details class="run-detail"/g) || []).length, 2)
      assert.equal((html.match(/class="gate"/g) || []).length, 3)
    })

    test('should show the label in html and fall back to the timestamp when unset', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_aaa', { label: 'tuned chunker' }))
      await writeRun(fakeReport('2026-07-30T11:00:00Z_bbb'))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes('<span class="run-label">tuned chunker</span>'))
      assert.ok(html.includes('07-30 11:00:00'))
    })

    test('should escape quotes and markup in a run label to prevent HTML injection', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_aaa', { label: 'evil"<img>' }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      // The label is escaped wherever it appears (run-label span, title= and
      // data-search= attributes), and the raw break-out sequence never occurs.
      assert.ok(html.includes('evil&quot;&lt;img&gt;'))
      assert.ok(!html.includes('evil"<img>'))
    })

    test('should keep per-question series aligned by run when a question is missing from a run', async () => {
      // q-002 is present in the oldest and newest runs but absent from the middle run.
      await writeRun(
        fakeReport('2026-07-30T10:00:00Z_r1', {
          perQuestion: [pq('q-001', 'q1', { mrr: 1 }), pq('q-002', 'q2', { mrr: 0.4 })]
        })
      )
      await writeRun(
        fakeReport('2026-07-30T11:00:00Z_r2', { perQuestion: [pq('q-001', 'q1', { mrr: 0.9 })] })
      )
      await writeRun(
        fakeReport('2026-07-30T12:00:00Z_r3', {
          perQuestion: [pq('q-001', 'q1', { mrr: 0.8 }), pq('q-002', 'q2', { mrr: 0.6 })]
        })
      )

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      const m = html.match(/<script id="pq-data" type="application\/json">(.*?)<\/script>/s)
      assert.ok(m)
      const blob = JSON.parse(m[1])
      const q2 = blob.data.find((q) => q.id === 'q-002')
      // One slot per run (3), null in the middle run that omitted it, newest value last.
      assert.equal(q2.series.mrr.length, 3)
      assert.equal(q2.series.mrr[1], null)
      assert.equal(q2.series.mrr[2], 0.6)
      // The average ignores the null slot: mean(0.4, 0.6) = 0.5.
      assert.equal(q2.avg.mrr, 0.5)
    })

    test('should order runs newest-first in the run-list section', async () => {
      await writeRun(fakeReport('2026-07-30T12:00:00Z_zzz'))
      await writeRun(fakeReport('2026-07-30T09:00:00Z_aaa'))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      const runListStart = html.indexOf('class="run-list"')
      assert.ok(runListStart !== -1)
      const runList = html.slice(runListStart)
      const iLate = runList.indexOf('2026-07-30T12:00:00Z_zzz')
      const iEarly = runList.indexOf('2026-07-30T09:00:00Z_aaa')
      assert.ok(iLate < iEarly, 'run-list: later (newest) run should appear before earlier run')
    })

    test('should use 2 columns in the chart grid', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_aaa'))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes('repeat(2,1fr)'))
    })

    test('should render one x-axis tick per run with truncation for long labels', async () => {
      const longLabel = 'a'.repeat(40) + ' / model-name-here'
      await writeRun(fakeReport('2026-07-30T10:00:00Z_aaa', { label: longLabel }))
      await writeRun(fakeReport('2026-07-30T11:00:00Z_bbb'))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      const tickCount = (html.match(/class="axis xtick"/g) || []).length
      assert.equal(tickCount, 4 * 2)
      assert.ok(html.includes('…'))
      const tickMatch = html.match(/class="axis xtick"[^>]*>([^<]+)<\/text>/)
      assert.ok(tickMatch && tickMatch[1].length <= 29)
    })
  })

  describe('when using md format', () => {
    test('should write compare.md with tables and no svg', async () => {
      await writeRun(
        fakeReport('2026-07-30T10:00:00Z_a', {
          perQuestion: [pq('cap-001', 'How do I define X?', { mrr: 0.5 })]
        })
      )

      const res = await compare({
        overrides: { output: { runsDir, compareFormat: 'md' } },
        logger: silentLogger
      })

      assert.equal(res.code, 0)
      assert.equal(res.format, 'md')
      assert.ok(res.outPath.endsWith('compare.md'))
      const md = await fs.readFile(path.join(runsDir, 'compare.md'), 'utf8')
      assert.match(md, /^# CAP MCP RAG/)
      assert.ok(md.includes('## Aggregate metrics across runs'))
      assert.ok(md.includes('## Per-question metrics (avg across runs)'))
      assert.ok(md.includes('## Inspect each run'))
      assert.ok(md.includes('cap-001'))
      assert.ok(!md.includes('<svg'))
      assert.ok(md.includes('All 1 question'))
      await assert.rejects(() => fs.access(path.join(runsDir, 'compare.html')))
    })

    test('should show the label in the aggregate matrix header', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_aaa', { label: 'tuned chunker' }))

      await compare({
        overrides: { output: { runsDir, compareFormat: 'md' } },
        logger: silentLogger
      })

      const md = await fs.readFile(path.join(runsDir, 'compare.md'), 'utf8')
      assert.ok(md.includes('| metric | gate | tuned chunker |'))
      assert.ok(md.includes('tuned chunker — `2026-07-30T10:00:00Z_aaa`'))
    })

    test('should escape backslashes and pipes in question text', async () => {
      await writeRun(
        fakeReport('2026-07-30T10:00:00Z_a', {
          perQuestion: [pq('cap-001', 'a\\b | c', { mrr: 0.5 })]
        })
      )

      await compare({
        overrides: { output: { runsDir, compareFormat: 'md' } },
        logger: silentLogger
      })

      const md = await fs.readFile(path.join(runsDir, 'compare.md'), 'utf8')
      assert.ok(md.includes('a\\\\b \\| c'))
    })

    test('should cap the per-question table to the top 50 for large golden sets', async () => {
      const mk = (rid, seed) => {
        const per = []
        for (let i = 1; i <= 120; i++) {
          per.push(
            pq('cap-' + String(i).padStart(3, '0'), 'Q' + i, { mrr: ((i + seed) % 10) / 10 })
          )
        }
        return fakeReport(rid, { perQuestion: per })
      }
      await writeRun(mk('2026-07-30T10:00:00Z_a', 0))
      await writeRun(mk('2026-07-30T11:00:00Z_b', 2))

      await compare({
        overrides: { output: { runsDir, compareFormat: 'md' } },
        logger: silentLogger
      })

      const md = await fs.readFile(path.join(runsDir, 'compare.md'), 'utf8')
      assert.ok(md.includes('Showing the 50 most-attention-worthy of 120 questions'))
      const section = md
        .split('## Per-question metrics (avg across runs)')[1]
        .split('## Inspect each run')[0]
      const rowCount = (section.match(/\n\| cap-/g) || []).length
      assert.equal(rowCount, 50)
    })
  })

  describe('per-question section', () => {
    test('should omit the per-question section when no run has per_question data', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_x'))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(!html.includes('Per-question metric trends'))
    })

    test('should render a searchable table and embedded data blob ordered by regression', async () => {
      const q1a = pq('cap-001', 'How do I define X?', { mrr: 1 })
      const q2a = pq('cap-002', 'How do I do Y?', { mrr: 0.5 })
      await writeRun(fakeReport('2026-07-30T10:00:00Z_a', { perQuestion: [q1a, q2a] }))
      const q1b = pq('cap-001', 'How do I define X?', { mrr: 0.333 })
      const q2b = pq('cap-002', 'How do I do Y?', { mrr: 0.5 })
      await writeRun(fakeReport('2026-07-30T11:00:00Z_b', { perQuestion: [q1b, q2b] }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes('Per-question metric trends'))
      assert.ok(html.includes('id="pq-table"'))
      assert.ok(html.includes('id="pq-search"'))
      assert.equal((html.match(/<figure class="chart">/g) || []).length, 4)
      const m = html.match(/id="pq-data"[^>]*>(.*?)<\/script>/s)
      assert.ok(m, 'pq-data blob present')
      const blob = JSON.parse(m[1].replace(/\\u003c/g, '<'))
      assert.equal(blob.data.length, 2)
      assert.equal(blob.data[0].id, 'cap-001')
      assert.ok(blob.data[0].question === 'How do I define X?')
    })

    test('should make all 6 metric header columns sortable', async () => {
      const q = pq('cap-001', 'Q?', { recall: 1, mrr: 0.5 })
      await writeRun(fakeReport('2026-07-30T10:00:00Z_a', { perQuestion: [q] }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      for (let col = 0; col <= 5; col++) {
        assert.ok(html.includes(`class="sortable" data-col="${col}"`), `data-col="${col}" missing`)
      }
      assert.ok(!html.includes('data-col="6"'))
    })

    test('should render one clickable row and one hidden detail row per question', async () => {
      const q1 = pq('cap-001', 'First question?')
      const q2 = pq('cap-002', 'Second question?')
      await writeRun(fakeReport('2026-07-30T10:00:00Z_a', { perQuestion: [q1, q2] }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.equal((html.match(/class="rd-pq-row"/g) || []).length, 2)
      assert.equal((html.match(/class="rd-pq-detail"/g) || []).length, 2)
      assert.ok(html.includes('class="rd-pq-detail" style="display:none"'))
    })

    test('should place retrieval content inside the detail row, not in a separate section', async () => {
      const q = {
        id: 'cap-001',
        question: 'Q?',
        relevant_doc_ids: ['https://x/a#hit'],
        retrieved_ids: [{ ids: ['https://x/a#hit'], text: 'chunk body text' }],
        relevant_hits_at_rank: [1],
        metrics: { recall_at_k: 1, mrr: 1, hit_rate_at_k: 1, ndcg_at_k: 1 }
      }
      await writeRun(fakeReport('2026-07-30T10:00:00Z_a', { perQuestion: [q] }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      const detailIdx = html.indexOf('class="rd-pq-detail"')
      assert.ok(detailIdx !== -1)
      assert.ok(html.indexOf('chunk body text') > detailIdx)
      assert.ok(!html.includes('Retrieved results per question'))
    })

    test('should assign a unique id based on the sanitized run_id to the per-question table', async () => {
      const q = pq('cap-001', 'Q?')
      const run_id = '2026-07-30T10:00:00Z_abc'
      await writeRun(fakeReport(run_id, { perQuestion: [q] }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      const sanitized = run_id.replace(/[^a-z0-9]/gi, '')
      assert.ok(html.includes(`id="rd-pq-${sanitized}"`))
    })

    test('should emit an inline script for a run that has per-question data', async () => {
      const q = pq('cap-001', 'Q?')
      const run_id = '2026-07-30T10:00:00Z_abc'
      await writeRun(fakeReport(run_id, { perQuestion: [q] }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      const sanitized = run_id.replace(/[^a-z0-9]/gi, '')
      assert.ok(html.includes(`getElementById('rd-pq-${sanitized}')`))
      assert.ok(html.includes('rd-pq-row'))
      assert.ok(html.includes('rd-pq-detail'))
    })

    test('should not emit a pq table or script when the run has no per-question data', async () => {
      const run_id = '2026-07-30T10:00:00Z_a'
      await writeRun(fakeReport(run_id))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      const sanitized = run_id.replace(/[^a-z0-9]/gi, '')
      assert.ok(!html.includes(`id="rd-pq-${sanitized}"`))
      assert.ok(!html.includes(`getElementById('rd-pq-${sanitized}')`))
      assert.ok(html.includes('No per-question data recorded'))
    })

    test('should show delta vs baseline in per-question metric cells when baseline_run_id is set', async () => {
      const baseQ = pq('cap-001', 'How do I define X?', { mrr: 0.5 })
      const base = fakeReport('2026-07-30T10:00:00Z_base', { perQuestion: [baseQ] })
      const currQ = pq('cap-001', 'How do I define X?', { mrr: 1 })
      const curr = {
        ...fakeReport('2026-07-30T11:00:00Z_curr', { perQuestion: [currQ] }),
        baseline_run_id: '2026-07-30T10:00:00Z_base'
      }
      await writeRun(base)
      await writeRun(curr)

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes('▲+0.500'))
    })

    test('should include runIds in the pq-data blob for client-side baseline selection', async () => {
      const q = pq('cap-001', 'Q?')
      await writeRun(fakeReport('2026-07-30T10:00:00Z_a', { perQuestion: [q] }))
      await writeRun(fakeReport('2026-07-30T11:00:00Z_b', { perQuestion: [q] }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      const m = html.match(/id="pq-data"[^>]*>(.*?)<\/script>/s)
      assert.ok(m, 'pq-data blob present')
      const blob = JSON.parse(m[1].replace(/\\u003c/g, '<'))
      assert.ok(Array.isArray(blob.runIds))
      assert.ok(blob.runIds.includes('2026-07-30T10:00:00Z_a'))
      assert.ok(blob.runIds.includes('2026-07-30T11:00:00Z_b'))
    })

    test('should include a diff-only button that is active by default', async () => {
      const q = pq('cap-001', 'Q?')
      const run_id = '2026-07-30T10:00:00Z_abc'
      await writeRun(fakeReport(run_id, { perQuestion: [q] }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      const sanitized = run_id.replace(/[^a-z0-9]/gi, '')
      assert.ok(html.includes(`id="rd-pq-${sanitized}-diff"`))
      assert.ok(html.includes('diff only'))
      assert.ok(html.includes('diffOnly=true'))
      assert.ok(html.includes("diffBtn.classList.add('active')"))
    })
  })

  describe('leaderboard', () => {
    test('should show all 5 metric rows', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_aaa', { recall: 0.9, mrr: 0.8 }))
      await writeRun(fakeReport('2026-07-30T11:00:00Z_bbb', { recall: 0.5, mrr: 0.4 }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes('class="lb-table"'))
      assert.ok(html.includes('Recall@K'))
      assert.ok(html.includes('MRR@K'))
      assert.ok(!html.includes('Precision@K'))
      assert.ok(html.includes('Hit-Rate@K'))
      assert.ok(html.includes('nDCG@K'))
      const lbBody = html.slice(
        html.indexOf('id="lb-tbody"'),
        html.indexOf('</tbody>', html.indexOf('id="lb-tbody"'))
      )
      const runRows = (lbBody.match(/<tr /g) || []).length
      assert.equal(runRows, 2)
    })

    test('should rank the best run first with a gold medal marker', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_aaa', { recall: 0.9, mrr: 0.8, hit: 0.9 }))
      await writeRun(fakeReport('2026-07-30T11:00:00Z_bbb', { recall: 0.3, mrr: 0.2, hit: 0.3 }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes('🥇'))
      const lbBody = html.slice(
        html.indexOf('id="lb-tbody"'),
        html.indexOf('</tbody>', html.indexOf('id="lb-tbody"'))
      )
      const iGold = lbBody.indexOf('🥇')
      const iSilver = lbBody.indexOf('🥈')
      assert.ok(iGold < iSilver)
    })
  })

  describe('run detail card', () => {
    test('should include an aggregate table and a per-question table in the card', async () => {
      const q = pq('cap-001', 'How do I define X?', { recall: 1, mrr: 0.5, hit: 1, ndcg: 0.65 })
      await writeRun(fakeReport('2026-07-30T10:00:00Z_a', { perQuestion: [q] }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.equal((html.match(/<details class="run-detail"/g) || []).length, 1)
      assert.equal((html.match(/class="rd-table"/g) || []).length, 2)
      assert.ok(html.includes('cap-001') && html.includes('How do I define X?'))
      assert.ok(html.includes('0.500'))
    })

    test('should show a rank column instead of delta and baseline columns', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_aaa', { recall: 0.9 }))
      await writeRun(fakeReport('2026-07-30T11:00:00Z_bbb', { recall: 0.5 }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes('>rank<'))
      assert.ok(!html.includes('Δ vs base'))
      assert.ok(!html.includes('>baseline<'))
      assert.ok(html.includes('>#1<') || html.includes('>#2<'))
    })

    test('should include a baseline radio button with a data-run-id attribute', async () => {
      const run_id = '2026-07-30T10:00:00Z_abc'
      await writeRun(fakeReport(run_id))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes(`class="baseline-radio" data-run-id="${run_id}"`))
      assert.ok(html.includes('name="pq-baseline"'))
    })

    test('should use the snapshot text for retrieved chunks even when the corpus is empty', async () => {
      const q = {
        id: 'cap-001',
        question: 'q',
        relevant_doc_ids: ['https://x/a#hit'],
        retrieved_ids: [
          { ids: ['https://x/a#hit'], text: 'snapshot body A' },
          { ids: ['https://x/b#miss'], text: 'snapshot body B' }
        ],
        relevant_hits_at_rank: [1],
        metrics: { recall_at_k: 1, mrr: 1, hit_rate_at_k: 1, ndcg_at_k: 1 }
      }
      await writeRun(fakeReport('2026-07-30T10:00:00Z_a', { perQuestion: [q] }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes('<details class="chunk">'))
      assert.ok(html.includes('snapshot body A') && html.includes('snapshot body B'))
    })

    test('should render a chunk without expansion when text is unavailable', async () => {
      const q = {
        id: 'cap-001',
        question: 'q',
        relevant_doc_ids: ['https://x/a#hit'],
        retrieved_ids: [{ ids: ['https://x/gone#stale'], text: '' }],
        relevant_hits_at_rank: [],
        metrics: { recall_at_k: 0, mrr: 0, hit_rate_at_k: 0, ndcg_at_k: 0 }
      }
      await writeRun(
        fakeReport('2026-07-30T10:00:00Z_a', { recall: 0, mrr: 0, hit: 0, perQuestion: [q] })
      )

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes('(text unavailable)'))
      assert.ok(!html.includes('<details class="chunk">'))
    })
  })

  describe('labels and x-axis', () => {
    test('should render the run label as a run-label span', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_a', { label: 'my-embedding-v2' }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes('<span class="run-label">my-embedding-v2</span>'))
    })

    test('should use the label as the x-axis tick in trend charts', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_a', { label: 'baseline' }))
      await writeRun(fakeReport('2026-07-30T11:00:00Z_b', { label: 'new-chunker' }))

      await compare({ overrides: overrides(), logger: silentLogger })

      const html = await fs.readFile(path.join(runsDir, 'compare.html'), 'utf8')
      assert.ok(html.includes('baseline'))
      assert.ok(html.includes('new-chunker'))
    })
  })

  describe('side-effects', () => {
    test('should not mutate the overrides object passed to compare', async () => {
      await writeRun(fakeReport('2026-07-30T10:00:00Z_aaa'))
      const opts = overrides()
      const keysBefore = Object.keys(opts)

      await compare({ overrides: opts, logger: silentLogger })

      assert.deepEqual(Object.keys(opts), keysBefore)
    })
  })
})
