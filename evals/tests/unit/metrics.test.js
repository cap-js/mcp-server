import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  recallAtK,
  precisionAtK,
  mrr,
  hitRateAtK,
  ndcgAtK,
  metricsFor,
  relevantHitsAtRank,
  round
} from '../../lib/metrics.js'

// Worked example from the spec (cap-001):
//   relevant  = [compositions, managed-compositions]
//   retrieved = [associations, compositions, domain-modeling, managed-compositions, entities]
//   k = 5  → relevant hits at ranks 2 and 4
//   expected: recall 1.0, precision 0.4, mrr 0.5, hit_rate 1, ndcg ≈ 0.651
const REL = ['compositions', 'managed-compositions']
const RET = ['associations', 'compositions', 'domain-modeling', 'managed-compositions', 'entities']

describe('metrics tests', () => {
  test('worked example: relevant hit ranks', () => {
    assert.deepEqual(relevantHitsAtRank(REL, RET, 5), [2, 4])
  })

  test('worked example: recall@5 = 1.0', () => {
    assert.equal(recallAtK(REL, RET, 5), 1.0)
  })

  test('worked example: precision@5 = 0.4', () => {
    assert.equal(precisionAtK(REL, RET, 5), 0.4)
  })

  test('worked example: mrr = 0.5 (first hit at rank 2)', () => {
    assert.equal(mrr(REL, RET, 5), 0.5)
  })

  test('worked example: hit_rate@5 = 1', () => {
    assert.equal(hitRateAtK(REL, RET, 5), 1)
  })

  test('worked example: ndcg@5 ≈ 0.651', () => {
    assert.equal(round(ndcgAtK(REL, RET, 5), 3), 0.651)
  })

  test('worked example: metricsFor bundles all five', () => {
    const m = metricsFor(REL, RET, 5)
    assert.equal(m.recall_at_k, 1.0)
    assert.equal(m.precision_at_k, 0.4)
    assert.equal(m.mrr, 0.5)
    assert.equal(m.hit_rate_at_k, 1)
    assert.equal(round(m.ndcg_at_k, 3), 0.651)
  })

  test('no relevant hits in top-k → zeros', () => {
    const rel = ['x']
    const ret = ['a', 'b', 'c']
    assert.equal(recallAtK(rel, ret, 3), 0)
    assert.equal(precisionAtK(rel, ret, 3), 0)
    assert.equal(mrr(rel, ret, 3), 0)
    assert.equal(hitRateAtK(rel, ret, 3), 0)
    assert.equal(ndcgAtK(rel, ret, 3), 0)
  })

  test('perfect ranking → all ones (ndcg=1)', () => {
    const rel = ['a', 'b']
    const ret = ['a', 'b', 'c', 'd']
    assert.equal(recallAtK(rel, ret, 2), 1)
    assert.equal(mrr(rel, ret, 2), 1)
    assert.equal(hitRateAtK(rel, ret, 2), 1)
    assert.equal(ndcgAtK(rel, ret, 2), 1)
  })

  test('first hit at rank 1 → mrr 1.0', () => {
    assert.equal(mrr(['a'], ['a', 'b', 'c'], 5), 1.0)
  })

  test('first hit at rank 4 → mrr 0.25', () => {
    assert.equal(mrr(['d'], ['a', 'b', 'c', 'd', 'e'], 5), 0.25)
  })

  test('duplicate relevant slots: recall counts distinct, precision counts slots', () => {
    // 'a' fills two of the three slots (a page returned twice).
    const rel = ['a', 'b']
    const ret = ['a', 'a', 'b']
    assert.equal(recallAtK(rel, ret, 3), 1) // distinct {a,b} found → 2/2
    assert.equal(precisionAtK(rel, ret, 3), 1) // 3 relevant slots / 3 = 1 (dupes count)
    assert.equal(mrr(rel, ret, 3), 1) // first relevant slot at rank 1
    assert.equal(hitRateAtK(rel, ret, 3), 1)
  })

  test('recall never exceeds 1 when a relevant page fills every slot', () => {
    assert.equal(recallAtK(['a'], ['a', 'a', 'a'], 3), 1) // one distinct relevant doc
    assert.equal(precisionAtK(['a'], ['a', 'a', 'a'], 3), 1) // 3/3 slots relevant
  })

  test('ndcg dedups relevant gain → duplicates cannot mask a bad rank', () => {
    // 'a' relevant, first appears at rank 2 then repeats at rank 3.
    // Old raw-slot sum: 1/log2(3)+1/log2(4)=1.131 → clamped to 1.0 (masked!).
    // Deduped: credit 'a' once at its best rank (2) → 1/log2(3)/1 ≈ 0.631.
    assert.equal(round(ndcgAtK(['a'], ['x', 'a', 'a'], 3), 3), 0.631)
    // a genuinely perfect ranking (rank 1) still scores 1.0
    assert.equal(ndcgAtK(['a'], ['a', 'a', 'b'], 3), 1)
  })

  test('precision divides by k even when fewer results returned', () => {
    // Only 2 retrieved, 1 relevant, k=5 → precision 1/5, not 1/2.
    assert.equal(precisionAtK(['a'], ['a', 'b'], 5), 0.2)
  })

  test('recall is fraction of relevant set, capped by what fits in k', () => {
    // 3 relevant, only 2 fit in top-2 → recall 2/3.
    const rel = ['a', 'b', 'c']
    const ret = ['a', 'b', 'x', 'c']
    assert.equal(recallAtK(rel, ret, 2), 2 / 3)
  })

  test('round() is deterministic on exact halves', () => {
    assert.equal(round(0.005, 2), 0.01)
    assert.equal(round(0.125, 2), 0.13)
    assert.equal(round(0.6510, 3), 0.651)
  })

  test('round() is symmetric for negatives (no -0, magnitude preserved)', () => {
    assert.equal(round(-0.005, 2), -0.01) // mirrors +0.005 → 0.01, not -0
    assert.equal(round(-0.015, 2), -0.02)
    assert.equal(round(-0.025, 2), -0.03)
    assert.ok(!Object.is(round(-0.004, 2), -0)) // rounds to a clean 0, not -0
    assert.equal(round(-0.004, 2), 0)
  })
})