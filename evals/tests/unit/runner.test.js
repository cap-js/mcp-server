import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReport,
  diagnose,
  preflight,
  worstQuestions,
  renderConsoleWithBaseline,
  makeRunId
} from '../../lib/runner.js'

const GATES = {
  recall_at_k: 0.8,
  mrr: 0.5,
  hit_rate_at_k: 0.8,
  precision_at_k: null,
  ndcg_at_k: null
}

const CONFIG = {
  capire_version: '2026.5.0',
  golden_set: 'test-set',
  golden_set_size: 2,
  k: 5
}

// Two-question fixture. Deterministic — no retriever, no ONNX.
function fixtureRaw(ret1, ret2) {
  return [
    { id: 'q-002', question: 'second', relevant_doc_ids: ['b'], retrieved_ids: ret2 },
    { id: 'q-001', question: 'first', relevant_doc_ids: ['a'], retrieved_ids: ret1 }
  ]
}

describe('eval tests', () => {
  test('pre-flight detects stale relevant ids', () => {
    const idSet = new Set(['a', 'c'])
    const stale = preflight([{ id: 'q1', relevant_doc_ids: ['a', 'b'] }], idSet)
    assert.deepEqual(stale, [{ question: 'q1', doc_id: 'b' }])
  })

  test('per_question is sorted by id ascending', () => {
    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['a'], ['b']),
      baseline: null,
      gates: GATES
    })
    assert.deepEqual(r.per_question.map(q => q.id), ['q-001', 'q-002'])
  })

  test('healthy run → overall pass, exit-worthy status pass', () => {
    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['a', 'x', 'y'], ['b', 'x', 'y']),
      baseline: null,
      gates: GATES
    })
    assert.equal(r.overall_status, 'pass')
    assert.deepEqual(r.gated_failures, [])
    assert.equal(r.aggregate.recall_at_k.status, 'pass')
    assert.equal(r.aggregate.precision_at_k.status, 'info') // gate null
  })

  test('MRR regression → gated failure + ranking diagnosis', () => {
    // baseline: both relevant at rank 1 (mrr 1.0)
    const baseReport = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['a'], ['b']),
      baseline: null,
      gates: GATES
    })
    const baseline = { run_id: 'base_1', ...baseReport }
    // now: relevant docs pushed to rank 4 → mrr 0.25 each, recall still 1
    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['x', 'y', 'z', 'a'], ['x', 'y', 'z', 'b']),
      baseline,
      gates: GATES
    })
    assert.equal(r.aggregate.recall_at_k.value, 1) // recall stable
    assert.ok(r.aggregate.mrr.value < 0.5) // mrr below gate
    assert.equal(r.aggregate.mrr.status, 'fail')
    assert.deepEqual(r.gated_failures, ['mrr'])
    assert.equal(r.overall_status, 'fail')
    assert.match(r.diagnosis, /ranking\/scoring regression/)
    assert.equal(r.baseline_run_id, 'base_1')
  })

  test('recall regression → chunking/embedding diagnosis (first match wins)', () => {
    const baseReport = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['a'], ['b']),
      baseline: null,
      gates: GATES
    })
    const baseline = { run_id: 'base_2', ...baseReport }
    // relevant docs fall out of top-5 entirely → recall down (and mrr down, but recall wins)
    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['x', 'y', 'z', 'p', 'q'], ['x', 'y', 'z', 'p', 'q']),
      baseline,
      gates: GATES
    })
    assert.ok(r.aggregate.recall_at_k.delta < 0)
    assert.match(r.diagnosis, /chunking\/embedding regression/)
    assert.deepEqual(r.gated_failures.sort(), ['hit_rate_at_k', 'mrr', 'recall_at_k'])
    assert.equal(r.overall_status, 'fail')
  })

  test('diagnose(): precision-only drop', () => {
    const agg = {
      recall_at_k: { delta: 0 },
      mrr: { delta: 0 },
      ndcg_at_k: { delta: 0 },
      precision_at_k: { delta: -0.1 }
    }
    assert.match(diagnose(agg), /top-K padded with noise/)
  })

  test('diagnose(): no regression', () => {
    const agg = {
      recall_at_k: { delta: 0.02 },
      mrr: { delta: 0.01 },
      ndcg_at_k: { delta: 0 },
      precision_at_k: { delta: 0 }
    }
    assert.equal(diagnose(agg), 'no_regression')
  })

  test('delta rounding: aggregate 2dp, per-question 3dp', () => {
    const baseReport = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['a'], ['b']),
      baseline: null,
      gates: GATES
    })
    const baseline = { run_id: 'base_3', ...baseReport }
    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['x', 'a'], ['b']), // q-001 mrr 0.5, q-002 mrr 1.0 → avg 0.75
      baseline,
      gates: GATES
    })
    // aggregate value rounded to 2dp
    assert.equal(r.aggregate.mrr.value, 0.75)
    assert.equal(r.aggregate.mrr.delta, -0.25) // 0.75 - 1.00
    // per-question metric 3dp precision
    const q1 = r.per_question.find(q => q.id === 'q-001')
    assert.equal(q1.metrics.mrr, 0.5)
  })

  test('DETERMINISM: same inputs → byte-identical report (ignoring run_id) and console', () => {
    const raw = fixtureRaw(['a', 'x'], ['x', 'b'])
    const r1 = buildReport({ config: CONFIG, perQuestionRaw: raw, baseline: null, gates: GATES })
    const r2 = buildReport({ config: CONFIG, perQuestionRaw: fixtureRaw(['a', 'x'], ['x', 'b']), baseline: null, gates: GATES })
    assert.equal(JSON.stringify(r1), JSON.stringify(r2))

    // Console body identical when run_id is fixed
    const runId = '2026-01-01T00:00:00Z_fixed1'
    const full1 = { run_id: runId, ...r1 }
    const full2 = { run_id: runId, ...r2 }
    const c1 = renderConsoleWithBaseline(full1, runId, { chunkCount: 1452 }, null)
    const c2 = renderConsoleWithBaseline(full2, runId, { chunkCount: 1452 }, null)
    assert.equal(c1, c2)
  })

  test('makeRunId is deterministic when now + rand are fixed', () => {
    const id = makeRunId(new Date('2026-07-30T07:11:55.123Z'), 'abc123')
    assert.equal(id, '2026-07-30T07:11:55Z_abc123')
  })

  test('worstQuestions: no baseline → lowest absolute MRR, noBaseline flag', () => {
    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['x', 'y', 'a'], ['b']), // q-001 mrr .333, q-002 mrr 1.0
      baseline: null,
      gates: GATES
    })
    const wq = worstQuestions({ ...r, baseline_run_id: null }, null)
    assert.equal(wq.noBaseline, true)
    assert.equal(wq.items[0].id, 'q-001') // lowest mrr first
  })

  test('worstQuestions: always lists weakest by absolute MRR, even with no regression', () => {
    const base = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['x', 'y', 'a'], ['b']), // q-001 weak (mrr .333), q-002 strong (1.0)
      baseline: null,
      gates: GATES
    })
    const baseline = { run_id: 'base_wq', ...base }
    // identical retrieval → nothing regressed, but q-001 is still the weakest
    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['x', 'y', 'a'], ['b']),
      baseline,
      gates: GATES
    })
    const wq = worstQuestions(r, baseline)
    assert.equal(wq.noBaseline, false)
    assert.ok(wq.items.length > 0) // NOT empty — weakest still shown
    assert.equal(wq.items[0].id, 'q-001') // weakest by absolute MRR
    assert.equal(wq.items[0].regressed, false) // unchanged vs baseline
    assert.match(wq.items[0].detail, /= baseline/) // annotated as no change
  })

  test('worstQuestions: annotates a real regression with the change + regressed flag', () => {
    const base = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['a'], ['b']), // both rank 1, mrr 1.0
      baseline: null,
      gates: GATES
    })
    const baseline = { run_id: 'base_wq2', ...base }
    // q-001 regresses: a → rank 3 (mrr .333); q-002 unchanged
    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['x', 'y', 'a'], ['b']),
      baseline,
      gates: GATES
    })
    const wq = worstQuestions(r, baseline)
    const q1 = wq.items.find(i => i.id === 'q-001')
    assert.ok(q1) // present because it's now the weakest
    assert.equal(q1.regressed, true)
    assert.match(q1.detail, /1\.00 ▼ 0\.33/) // baseline → now, with down arrow
  })

})