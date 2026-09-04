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
  mean,
  round
} from '../../lib/metrics.js'

function mkChunks(...ids) {
  return ids.map(id => ({ ids: [id], text: '' }))
}

// Worked example from the spec (cap-001):
//   relevant  = [compositions, managed-compositions]
//   retrieved = [associations, compositions, domain-modeling, managed-compositions, entities]
//   k = 5  → relevant hits at ranks 2 and 4
//   expected: recall 1.0, precision 0.4, mrr 0.5, hit_rate 1, ndcg ≈ 0.651
const REL = ['compositions', 'managed-compositions']
const RET = mkChunks('associations', 'compositions', 'domain-modeling', 'managed-compositions', 'entities')

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
    const ret = mkChunks('a', 'b', 'c')
    assert.equal(recallAtK(rel, ret, 3), 0)
    assert.equal(precisionAtK(rel, ret, 3), 0)
    assert.equal(mrr(rel, ret, 3), 0)
    assert.equal(hitRateAtK(rel, ret, 3), 0)
    assert.equal(ndcgAtK(rel, ret, 3), 0)
  })

  test('perfect ranking → all ones (ndcg=1)', () => {
    const rel = ['a', 'b']
    const ret = mkChunks('a', 'b', 'c', 'd')
    assert.equal(recallAtK(rel, ret, 2), 1)
    assert.equal(mrr(rel, ret, 2), 1)
    assert.equal(hitRateAtK(rel, ret, 2), 1)
    assert.equal(ndcgAtK(rel, ret, 2), 1)
  })

  test('first hit at rank 1 → mrr 1.0', () => {
    assert.equal(mrr(['a'], mkChunks('a', 'b', 'c'), 5), 1.0)
  })

  test('first hit at rank 4 → mrr 0.25', () => {
    assert.equal(mrr(['d'], mkChunks('a', 'b', 'c', 'd', 'e'), 5), 0.25)
  })

  test('duplicate relevant slots: recall counts distinct, precision counts distinct groups', () => {
    // 'a' fills two of the three slots (a page returned twice).
    const rel = ['a', 'b']
    const ret = mkChunks('a', 'a', 'b')
    assert.equal(recallAtK(rel, ret, 3), 1) // distinct {a,b} found → 2/2
    // precision now credits each group once: {a,b} / 3 slots = 2/3
    assert.equal(precisionAtK(rel, ret, 3), 2 / 3)
    assert.equal(mrr(rel, ret, 3), 1) // first relevant slot at rank 1
    assert.equal(hitRateAtK(rel, ret, 3), 1)
  })

  test('recall never exceeds 1 when a relevant page fills every slot', () => {
    assert.equal(recallAtK(['a'], mkChunks('a', 'a', 'a'), 3), 1) // one distinct relevant doc
    // precision credits group 'a' once → 1/3, not 3/3
    assert.equal(precisionAtK(['a'], mkChunks('a', 'a', 'a'), 3), 1 / 3)
  })

  test('ndcg dedups relevant gain → duplicates cannot mask a bad rank', () => {
    // 'a' relevant, first appears at rank 2 then repeats at rank 3.
    // Old raw-slot sum: 1/log2(3)+1/log2(4)=1.131 → clamped to 1.0 (masked!).
    // Deduped: credit 'a' once at its best rank (2) → 1/log2(3)/1 ≈ 0.631.
    assert.equal(round(ndcgAtK(['a'], mkChunks('x', 'a', 'a'), 3), 3), 0.631)
    // a genuinely perfect ranking (rank 1) still scores 1.0
    assert.equal(ndcgAtK(['a'], mkChunks('a', 'a', 'b'), 3), 1)
  })

  test('precision divides by k even when fewer results returned', () => {
    // Only 2 retrieved, 1 relevant, k=5 → precision 1/5, not 1/2.
    assert.equal(precisionAtK(['a'], mkChunks('a', 'b'), 5), 0.2)
  })

  test('recall is fraction of relevant set, capped by what fits in k', () => {
    // 3 relevant, only 2 fit in top-2 → recall 2/3.
    const rel = ['a', 'b', 'c']
    const ret = mkChunks('a', 'b', 'x', 'c')
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

  test('edge guards: empty relevant set and k<=0 → 0', () => {
    assert.equal(recallAtK([], mkChunks('a'), 5), 0) // no relevant docs
    assert.equal(ndcgAtK([], mkChunks('a'), 5), 0)
    assert.equal(precisionAtK(['a'], mkChunks('a'), 0), 0) // k = 0
    assert.equal(mean([]), 0) // empty mean
  })

  test('OR-group: only one alternate retrieved → group credited once', () => {
    // One group with two alternates; retriever finds only the second.
    const rel = [['a1', 'a2']]
    const ret = mkChunks('x', 'a2', 'y')
    assert.equal(recallAtK(rel, ret, 5), 1) // 1 group / 1
    assert.equal(hitRateAtK(rel, ret, 5), 1)
    assert.equal(mrr(rel, ret, 5), 1 / 2)
    // ideal: single group at rank 1 → idcg = 1; actual: rank 2 → 1/log2(3)
    assert.equal(round(ndcgAtK(rel, ret, 5), 3), round(1 / Math.log2(3), 3))
  })

  test('OR-group: both alternates retrieved → still counts once (no double credit)', () => {
    const rel = [['a1', 'a2']]
    const ret = mkChunks('a1', 'a2', 'x')
    assert.equal(recallAtK(rel, ret, 5), 1) // one group, one credit
    // nDCG: group credited only at its best rank (1) → dcg = 1, idcg = 1
    assert.equal(ndcgAtK(rel, ret, 5), 1)
    // precision: one group across the top-K / k = 1/5, not 2/5
    assert.equal(precisionAtK(rel, ret, 5), 1 / 5)
  })

  test('mixed groups: plain id + OR-group; only plain id found → recall 1/2', () => {
    const rel = ['plain', ['a1', 'a2']]
    const ret = mkChunks('plain', 'x', 'y')
    assert.equal(recallAtK(rel, ret, 5), 1 / 2) // 1 of 2 groups
    assert.equal(hitRateAtK(rel, ret, 5), 1)
    assert.equal(mrr(rel, ret, 5), 1) // first hit at rank 1
  })

  test('mixed groups: both groups found via different alternates', () => {
    const rel = ['plain', ['a1', 'a2']]
    const ret = mkChunks('a2', 'plain', 'x')
    assert.equal(recallAtK(rel, ret, 5), 1) // both groups matched
    // best ranks: group0 (plain) at rank 2 → 1/log2(3); group1 at rank 1 → 1
    // idcg (2 groups at 1,2) = 1 + 1/log2(3)
    const idcg = 1 + 1 / Math.log2(3)
    const dcg = 1 + 1 / Math.log2(3)
    assert.equal(round(ndcgAtK(rel, ret, 5), 3), round(dcg / idcg, 3))
  })

  test('OR-group precision: both alternates across different slots → 1 group / k', () => {
    // Two alternates of ONE group land in slots 1 and 3.
    // Old (id-count) would give 2/5; group-based gives 1/5.
    const rel = [['a1', 'a2']]
    const ret = mkChunks('a1', 'x', 'a2', 'y', 'z')
    assert.equal(precisionAtK(rel, ret, 5), 1 / 5)
    assert.equal(recallAtK(rel, ret, 5), 1)
    assert.equal(hitRateAtK(rel, ret, 5), 1)
    assert.equal(mrr(rel, ret, 5), 1) // first alternate at rank 1
  })

  test('OR-group precision: same alternate duplicated across slots → still 1 / k', () => {
    // The retriever returns the same alternate 'a1' in three slots.
    const rel = [['a1', 'a2']]
    const ret = mkChunks('a1', 'a1', 'a1', 'x', 'y')
    assert.equal(precisionAtK(rel, ret, 5), 1 / 5) // one group credited
    assert.equal(recallAtK(rel, ret, 5), 1)
  })

  test('OR-group nDCG: alternate #2 shows before alternate #1 → credit at BEST (earliest) rank', () => {
    // Group present at ranks 2 and 4; nDCG must use rank 2, not rank 4.
    const rel = [['a1', 'a2']]
    const ret = mkChunks('x', 'a2', 'y', 'a1', 'z')
    // dcg = 1/log2(3); idcg = 1 (one group ideal-packed at rank 1)
    assert.equal(round(ndcgAtK(rel, ret, 5), 6), round(1 / Math.log2(3), 6))
  })

  test('OR-group hitRate/mrr: earliest alternate wins', () => {
    const rel = [['a1', 'a2', 'a3']]
    // a3 at rank 2, a1 at rank 4 → mrr = 1/2 (whichever alternate comes first)
    const ret = mkChunks('x', 'a3', 'y', 'a1', 'z')
    assert.equal(hitRateAtK(rel, ret, 5), 1)
    assert.equal(mrr(rel, ret, 5), 1 / 2)
  })

  test('OR-group relevantHitsAtRank: every slot that matches the group records its rank', () => {
    // Both alternates present in different slots — both slots' ranks are recorded.
    // (This is a slot-level trace, not a group-credit metric.)
    const rel = [['a1', 'a2']]
    const ret = mkChunks('x', 'a1', 'y', 'a2', 'z')
    assert.deepEqual(relevantHitsAtRank(rel, ret, 5), [2, 4])
  })

  test('mixed groups precision: plain hit + OR-group both-alternates hit → 2 groups / k', () => {
    // Two distinct groups matched; precision = 2/5 regardless of duplicate slots.
    const rel = ['plain', ['a1', 'a2']]
    const ret = mkChunks('plain', 'a1', 'a2', 'x', 'y')
    assert.equal(precisionAtK(rel, ret, 5), 2 / 5)
    assert.equal(recallAtK(rel, ret, 5), 1)
  })

  test('OR-group with three alternates, only middle one retrieved → recall 1, precision 1/k', () => {
    const rel = [['a1', 'a2', 'a3']]
    const ret = mkChunks('x', 'a2', 'y', 'z', 'q')
    assert.equal(recallAtK(rel, ret, 5), 1)
    assert.equal(precisionAtK(rel, ret, 5), 1 / 5)
    assert.equal(mrr(rel, ret, 5), 1 / 2)
  })

  test('OR-group: none of the alternates retrieved → all zeros', () => {
    const rel = [['a1', 'a2']]
    const ret = mkChunks('x', 'y', 'z')
    assert.equal(recallAtK(rel, ret, 5), 0)
    assert.equal(precisionAtK(rel, ret, 5), 0)
    assert.equal(mrr(rel, ret, 5), 0)
    assert.equal(hitRateAtK(rel, ret, 5), 0)
    assert.equal(ndcgAtK(rel, ret, 5), 0)
  })

  test('two OR-groups both fully retrieved → each counts once (precision 2/k, recall 1)', () => {
    const rel = [['a1', 'a2'], ['b1', 'b2']]
    const ret = mkChunks('a1', 'a2', 'b1', 'b2', 'x')
    assert.equal(recallAtK(rel, ret, 5), 1) // 2 groups / 2
    assert.equal(precisionAtK(rel, ret, 5), 2 / 5) // 2 groups credited across k=5
    // nDCG: group0 best rank 1, group1 best rank 3; idcg = 1 + 1/log2(3)
    const dcg = 1 + 1 / Math.log2(4)
    const idcg = 1 + 1 / Math.log2(3)
    assert.equal(round(ndcgAtK(rel, ret, 5), 3), round(dcg / idcg, 3))
  })

  test('slot with multiple ids from the SAME group → still one group credit', () => {
    // A single slot lists both alternates. Must not double-count.
    const rel = [['a1', 'a2']]
    const ret = [{ ids: ['a1', 'a2'], text: '' }, { ids: ['x'], text: '' }]
    assert.equal(precisionAtK(rel, ret, 5), 1 / 5)
    assert.equal(recallAtK(rel, ret, 5), 1)
    assert.equal(ndcgAtK(rel, ret, 5), 1) // best rank = 1
  })

  test('slot with ids from TWO different groups → both groups credited', () => {
    // One slot contains ids belonging to two distinct groups.
    const rel = [['a1'], ['b1', 'b2']]
    const ret = [{ ids: ['a1', 'b2'], text: '' }, { ids: ['x'], text: '' }]
    assert.equal(recallAtK(rel, ret, 5), 1) // 2 groups / 2
    assert.equal(precisionAtK(rel, ret, 5), 2 / 5) // 2 distinct groups in top-K
  })
})
