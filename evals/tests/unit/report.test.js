import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, diagnose, preflight, validateGolden, makeRunId } from '../../lib/report.js'

function mkChunks(...ids) {
  return ids.map((id) => ({ ids: [id], text: '' }))
}

const GATES = {
  recall_at_k: 0.8,
  mrr: 0.5,
  hit_rate_at_k: 0.8,
  ndcg_at_k: null
}

const CONFIG = {
  capire_version: '2026.5.0',
  golden_set: 'test-set',
  golden_set_size: 2,
  k: 5
}

function fixtureRaw(ret1, ret2) {
  return [
    { id: 'q-002', question: 'second', relevant_doc_ids: ['b'], retrievedIds: ret2 },
    { id: 'q-001', question: 'first', relevant_doc_ids: ['a'], retrievedIds: ret1 }
  ]
}

describe('report', () => {
  test('should detect stale relevant ids in preflight', async () => {
    const fakeDb = { run: mock.fn(async () => [{ source: 'a' }, { source: 'c' }]) }

    const stale = await preflight([{ id: 'q1', relevant_doc_ids: ['a', 'b'] }], fakeDb)

    assert.deepEqual(stale, [{ question: 'q1', doc_id: 'b' }])
  })

  test('should accept a well-formed golden set in validateGolden', () => {
    const ok = [
      { id: 'q-001', question: 'a?', relevant_doc_ids: ['x'] },
      { id: 'q-002', question: 'b?', relevant_doc_ids: ['y', 'z'] }
    ]

    assert.deepEqual(validateGolden(ok), [])
  })

  test('should report all validation errors for missing, duplicate, empty, and null entries', () => {
    const bad = [
      { id: 'q-001', question: 'a?', relevant_doc_ids: ['x'] },
      { id: 'q-001', question: 'dup id', relevant_doc_ids: ['y'] },
      { id: 'q-002', question: 'no rel' },
      { id: 'q-003', question: 'empty', relevant_doc_ids: [] },
      { id: 'q-004', question: 'nullid', relevant_doc_ids: [null] },
      { id: 'q-005', relevant_doc_ids: ['z'] },
      null
    ]

    const problems = validateGolden(bad)

    assert.ok(problems.some((p) => /duplicate id/.test(p)))
    assert.ok(problems.some((p) => /q-002.*must be an array/.test(p)))
    assert.ok(problems.some((p) => /q-003.*empty/.test(p)))
    assert.ok(problems.some((p) => /q-004.*non-string\/empty/.test(p)))
    assert.ok(problems.some((p) => /q-005.*missing non-empty "question"/.test(p)))
    assert.ok(problems.some((p) => /not an object/.test(p)))
  })

  test('should sort per_question by id ascending in the built report', () => {
    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(mkChunks('a'), mkChunks('b')),
      baseline: null,
      gates: GATES
    })

    assert.deepEqual(
      r.per_question.map((q) => q.id),
      ['q-001', 'q-002']
    )
  })

  test('should set overall_status to pass and have no gated failures for a healthy run', () => {
    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(mkChunks('a', 'x', 'y'), mkChunks('b', 'x', 'y')),
      baseline: null,
      gates: GATES
    })

    assert.equal(r.overall_status, 'pass')
    assert.deepEqual(r.gated_failures, [])
    assert.equal(r.aggregate.recall_at_k.status, 'pass')
  })

  test('should produce a ranking diagnosis and record the gated failure when MRR falls below gate', () => {
    const baseReport = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(mkChunks('a'), mkChunks('b')),
      baseline: null,
      gates: GATES
    })
    const baseline = { run_id: 'base_1', ...baseReport }

    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(mkChunks('x', 'y', 'z', 'a'), mkChunks('x', 'y', 'z', 'b')),
      baseline,
      gates: GATES
    })

    assert.equal(r.aggregate.recall_at_k.value, 1)
    assert.ok(r.aggregate.mrr.value < 0.5)
    assert.equal(r.aggregate.mrr.status, 'fail')
    assert.deepEqual(r.gated_failures, ['mrr'])
    assert.equal(r.overall_status, 'fail')
    assert.match(r.diagnosis, /ranking\/scoring regression/)
    assert.equal(r.baseline_run_id, 'base_1')
  })

  test('should compute a real delta and not null when the baseline value is zero', () => {
    const baseReport = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(mkChunks('x', 'y'), mkChunks('x', 'y')),
      baseline: null,
      gates: GATES
    })
    assert.equal(baseReport.aggregate.mrr.value, 0)
    const baseline = { run_id: 'base_0', ...baseReport }

    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(mkChunks('a'), mkChunks('b')),
      baseline,
      gates: GATES
    })

    assert.equal(r.aggregate.mrr.baseline, 0)
    assert.equal(r.aggregate.mrr.delta, 1)
  })

  test('should produce a chunking diagnosis when recall drops', () => {
    const baseReport = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(mkChunks('a'), mkChunks('b')),
      baseline: null,
      gates: GATES
    })
    const baseline = { run_id: 'base_2', ...baseReport }

    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(
        mkChunks('x', 'y', 'z', 'p', 'q'),
        mkChunks('x', 'y', 'z', 'p', 'q')
      ),
      baseline,
      gates: GATES
    })

    assert.ok(r.aggregate.recall_at_k.delta < 0)
    assert.match(r.diagnosis, /chunking\/embedding regression/)
    assert.deepEqual(r.gated_failures.sort(), ['hit_rate_at_k', 'mrr', 'recall_at_k'])
    assert.equal(r.overall_status, 'fail')
  })

  test('should return no_regression when all metric deltas are non-negative', () => {
    const agg = {
      recall_at_k: { delta: 0.02 },
      mrr: { delta: 0.01 },
      ndcg_at_k: { delta: 0 }
    }

    assert.equal(diagnose(agg), 'no_regression')
  })

  test('should return no_regression for drops within the dead band', () => {
    const agg = {
      recall_at_k: { delta: -0.02 },
      mrr: { delta: -0.01 },
      ndcg_at_k: { delta: -0.02 }
    }

    assert.equal(diagnose(agg), 'no_regression')
  })

  test('should produce a chunking diagnosis and suppress a ranking diagnosis when recall drops', () => {
    const agg = {
      recall_at_k: { delta: -0.1 },
      mrr: { delta: 0 },
      ndcg_at_k: { delta: -0.1 }
    }

    const d = diagnose(agg)

    assert.match(d, /chunking\/embedding regression/)
    assert.doesNotMatch(d, /ranking\/scoring regression/)
  })

  test('should round aggregate values to 2dp and per-question values to 3dp', () => {
    const baseReport = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(mkChunks('a'), mkChunks('b')),
      baseline: null,
      gates: GATES
    })
    const baseline = { run_id: 'base_3', ...baseReport }

    const r = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(mkChunks('x', 'a'), mkChunks('b')),
      baseline,
      gates: GATES
    })

    assert.equal(r.aggregate.mrr.value, 0.75)
    assert.equal(r.aggregate.mrr.delta, -0.25)
    const q1 = r.per_question.find((q) => q.id === 'q-001')
    assert.equal(q1.metrics.mrr, 0.5)
  })

  test('should produce byte-identical reports for the same inputs', () => {
    const r1 = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(mkChunks('a', 'x'), mkChunks('x', 'b')),
      baseline: null,
      gates: GATES
    })
    const r2 = buildReport({
      config: CONFIG,
      perQuestionRaw: fixtureRaw(mkChunks('a', 'x'), mkChunks('x', 'b')),
      baseline: null,
      gates: GATES
    })

    assert.equal(JSON.stringify(r1), JSON.stringify(r2))
  })

  test('should produce a deterministic run id when now and rand are fixed', () => {
    const id = makeRunId(new Date('2026-07-30T07:11:55.123Z'), 'abc123')

    assert.equal(id, '2026-07-30T07:11:55.123Z_abc123')
  })

  test('should keep millisecond precision in run ids so same-second runs sort by time', () => {
    const early = makeRunId(new Date('2026-07-30T07:11:55.001Z'), 'zzzzzz')
    const late = makeRunId(new Date('2026-07-30T07:11:55.005Z'), 'aaaaaa')

    assert.ok(early < late)
  })

  test('should accept OR-group entries alongside plain strings in validateGolden', () => {
    const ok = [{ id: 'q-001', question: 'a?', relevant_doc_ids: ['x', ['y1', 'y2']] }]

    assert.deepEqual(validateGolden(ok), [])
  })

  test('should reject empty OR-groups and empty ids inside a group in validateGolden', () => {
    const bad = [
      { id: 'q-001', question: 'a?', relevant_doc_ids: [[]] },
      { id: 'q-002', question: 'b?', relevant_doc_ids: [['']] },
      { id: 'q-003', question: 'c?', relevant_doc_ids: ['ok', []] }
    ]

    const problems = validateGolden(bad)

    assert.ok(problems.some((p) => /q-001.*empty OR-group/.test(p)))
    assert.ok(problems.some((p) => /q-002.*non-string\/empty/.test(p)))
    assert.ok(problems.some((p) => /q-003.*empty OR-group/.test(p)))
  })

  test('should flag a stale alternate inside an OR-group and leave valid siblings clean', async () => {
    const fakeDb = { run: mock.fn(async () => [{ source: 'y1' }]) }

    const stale = await preflight([{ id: 'q1', relevant_doc_ids: [['y1', 'y2-stale']] }], fakeDb)

    assert.deepEqual(stale, [{ question: 'q1', doc_id: 'y2-stale' }])
  })

  test('should score an OR-group as one group in buildReport', () => {
    const raw = [
      {
        id: 'q-001',
        question: 'orgroup?',
        relevant_doc_ids: [['a1', 'a2']],
        retrievedIds: mkChunks('a2', 'x', 'y')
      }
    ]

    const r = buildReport({ config: CONFIG, perQuestionRaw: raw, baseline: null, gates: GATES })
    const q = r.per_question[0]

    assert.equal(q.metrics.recall_at_k, 1)
    assert.equal(q.metrics.hit_rate_at_k, 1)
    assert.equal(q.metrics.mrr, 1)
    assert.deepEqual(q.relevant_doc_ids, [['a1', 'a2']])
  })

  describe('side-effects', () => {
    test('should not mutate the gates object passed to buildReport', () => {
      const gates = { ...GATES }
      const keysBefore = Object.keys(gates)

      buildReport({
        config: CONFIG,
        perQuestionRaw: fixtureRaw(mkChunks('a'), mkChunks('b')),
        baseline: null,
        gates
      })

      assert.deepEqual(Object.keys(gates), keysBefore)
    })

    test('should not add properties to question entries in the golden set passed to validateGolden', () => {
      const entry = { id: 'q-001', question: 'a?', relevant_doc_ids: ['x'] }
      const keysBefore = Object.keys(entry)

      validateGolden([entry])

      assert.deepEqual(Object.keys(entry), keysBefore)
    })
  })
})
