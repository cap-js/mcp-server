import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReport,
  diagnose,
  preflight,
  validateGolden,
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

  test('validateGolden: accepts a well-formed set', () => {
    const ok = [
      { id: 'q-001', question: 'a?', relevant_doc_ids: ['x'] },
      { id: 'q-002', question: 'b?', relevant_doc_ids: ['y', 'z'] }
    ]
    assert.deepEqual(validateGolden(ok), [])
  })

  test('validateGolden: catches missing/empty/duplicate/null cases', () => {
    const bad = [
      { id: 'q-001', question: 'a?', relevant_doc_ids: ['x'] },
      { id: 'q-001', question: 'dup id', relevant_doc_ids: ['y'] }, // duplicate id
      { id: 'q-002', question: 'no rel' }, // missing relevant_doc_ids
      { id: 'q-003', question: 'empty', relevant_doc_ids: [] }, // empty ground truth
      { id: 'q-004', question: 'nullid', relevant_doc_ids: [null] }, // null entry
      { id: 'q-005', relevant_doc_ids: ['z'] }, // missing question
      null // not an object at all
    ]
    const problems = validateGolden(bad)
    assert.ok(problems.some(p => /duplicate id/.test(p)))
    assert.ok(problems.some(p => /q-002.*must be an array/.test(p)))
    assert.ok(problems.some(p => /q-003.*empty/.test(p)))
    assert.ok(problems.some(p => /q-004.*non-string\/empty/.test(p)))
    assert.ok(problems.some(p => /q-005.*missing non-empty "question"/.test(p)))
    assert.ok(problems.some(p => /not an object/.test(p)))
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

  test('zero baseline value yields a real delta, not null', () => {
    // baseline: relevant docs absent → recall/mrr aggregate 0.00
    const baseReport = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['x', 'y'], ['x', 'y']),
      baseline: null,
      gates: GATES
    })
    assert.equal(baseReport.aggregate.mrr.value, 0) // precondition: baseline is 0
    const baseline = { run_id: 'base_0', ...baseReport }
    // now: both relevant at rank 1 → mrr 1.0, a genuine improvement from 0
    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(['a'], ['b']),
      baseline,
      gates: GATES
    })
    assert.equal(r.aggregate.mrr.baseline, 0)
    assert.equal(r.aggregate.mrr.delta, 1) // was masked to null before the fix
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

  test('diagnose(): a within-dead-band drop is NOT a regression', () => {
    // -0.02 is exactly the dead-band; must not trip a cause (noise on n=10).
    const agg = {
      recall_at_k: { delta: -0.02 },
      mrr: { delta: -0.01 },
      ndcg_at_k: { delta: -0.02 },
      precision_at_k: { delta: -0.02 }
    }
    assert.equal(diagnose(agg), 'no_regression')
  })

  test('diagnose(): reports ALL causes above dead-band, not first-match-wins', () => {
    // recall AND precision both drop meaningfully → both reported.
    const agg = {
      recall_at_k: { delta: -0.1 },
      mrr: { delta: 0 },
      ndcg_at_k: { delta: 0 },
      precision_at_k: { delta: -0.1 }
    }
    const d = diagnose(agg)
    assert.match(d, /chunking\/embedding regression/)
    assert.match(d, /top-K padded with noise/)
    assert.ok(d.includes(';')) // multiple causes joined
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

  test('DETERMINISM: same inputs → byte-identical report (ignoring run_id)', () => {
    const r1 = buildReport({ config: CONFIG, perQuestionRaw: fixtureRaw(['a', 'x'], ['x', 'b']), baseline: null, gates: GATES })
    const r2 = buildReport({ config: CONFIG, perQuestionRaw: fixtureRaw(['a', 'x'], ['x', 'b']), baseline: null, gates: GATES })
    assert.equal(JSON.stringify(r1), JSON.stringify(r2))
  })

  test('makeRunId is deterministic when now + rand are fixed', () => {
    const id = makeRunId(new Date('2026-07-30T07:11:55.123Z'), 'abc123')
    assert.equal(id, '2026-07-30T07:11:55.123Z_abc123')
  })

  test('makeRunId keeps millisecond precision → same-second runs sort by time', () => {
    // Two runs 4ms apart in the same wall-clock second must order by time,
    // not by the random suffix.
    const early = makeRunId(new Date('2026-07-30T07:11:55.001Z'), 'zzzzzz')
    const late = makeRunId(new Date('2026-07-30T07:11:55.005Z'), 'aaaaaa')
    assert.ok(early < late) // string sort respects the ms component
  })

})