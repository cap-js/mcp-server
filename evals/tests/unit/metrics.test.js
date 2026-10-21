import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  recallAtK,
  mrr,
  hitRateAtK,
  ndcgAtK,
  metricsFor,
  relevantHitsAtRank,
  mean,
  round
} from '../../lib/metrics.js'
import { mkChunks } from '../helpers.js'

// Worked example from the spec (cap-001):
//   relevant  = [compositions, managed-compositions]
//   retrieved = [associations, compositions, domain-modeling, managed-compositions, entities]
//   k = 5  → relevant hits at ranks 2 and 4
const REL = ['compositions', 'managed-compositions']
const RET = mkChunks('associations', 'compositions', 'domain-modeling', 'managed-compositions', 'entities')

describe('metrics', () => {
  test('should return [2, 4] for relevantHitsAtRank when relevant docs are at ranks 2 and 4', () => {
    assert.deepEqual(relevantHitsAtRank(REL, RET, 5), [2, 4])
  })

  test('should return 1.0 for recallAtK when all relevant docs are retrieved within k', () => {
    assert.equal(recallAtK(REL, RET, 5), 1.0)
  })

  test('should return 0.5 for mrr when the first relevant hit is at rank 2', () => {
    assert.equal(mrr(REL, RET, 5), 0.5)
  })

  test('should return 1 for hitRateAtK when at least one relevant doc is within k', () => {
    assert.equal(hitRateAtK(REL, RET, 5), 1)
  })

  test('should return 0.651 for ndcgAtK when relevant docs are at ranks 2 and 4 of 5', () => {
    assert.equal(round(ndcgAtK(REL, RET, 5), 3), 0.651)
  })

  test('should return all four correct metric values from metricsFor', () => {
    const m = metricsFor(REL, RET, 5)

    assert.equal(m.recall_at_k, 1.0)
    assert.equal(m.mrr, 0.5)
    assert.equal(m.hit_rate_at_k, 1)
    assert.equal(round(m.ndcg_at_k, 3), 0.651)
  })

  describe('when no relevant doc is in top-k', () => {
    const rel = ['x']
    const ret = mkChunks('a', 'b', 'c')

    test('should return 0 for recallAtK', () => {
      assert.equal(recallAtK(rel, ret, 3), 0)
    })

    test('should return 0 for mrr', () => {
      assert.equal(mrr(rel, ret, 3), 0)
    })

    test('should return 0 for hitRateAtK', () => {
      assert.equal(hitRateAtK(rel, ret, 3), 0)
    })

    test('should return 0 for ndcgAtK', () => {
      assert.equal(ndcgAtK(rel, ret, 3), 0)
    })
  })

  describe('when relevant docs fill the top positions', () => {
    const rel = ['a', 'b']
    const ret = mkChunks('a', 'b', 'c', 'd')

    test('should return 1 for recallAtK', () => {
      assert.equal(recallAtK(rel, ret, 2), 1)
    })

    test('should return 1 for mrr', () => {
      assert.equal(mrr(rel, ret, 2), 1)
    })

    test('should return 1 for hitRateAtK', () => {
      assert.equal(hitRateAtK(rel, ret, 2), 1)
    })

    test('should return 1 for ndcgAtK', () => {
      assert.equal(ndcgAtK(rel, ret, 2), 1)
    })
  })

  test('should return mrr 1.0 when the first hit is at rank 1', () => {
    assert.equal(mrr(['a'], mkChunks('a', 'b', 'c'), 5), 1.0)
  })

  test('should return mrr 0.25 when the first hit is at rank 4', () => {
    assert.equal(mrr(['d'], mkChunks('a', 'b', 'c', 'd', 'e'), 5), 0.25)
  })

  describe('when a relevant page fills multiple slots', () => {
    const rel = ['a', 'b']
    const ret = mkChunks('a', 'a', 'b')

    test('should count distinct groups for recallAtK', () => {
      assert.equal(recallAtK(rel, ret, 3), 1)
    })

    test('should use the first relevant slot for mrr', () => {
      assert.equal(mrr(rel, ret, 3), 1)
    })

    test('should return 1 for hitRateAtK', () => {
      assert.equal(hitRateAtK(rel, ret, 3), 1)
    })
  })

  test('should return 1 for recallAtK when a single relevant doc fills every slot', () => {
    assert.equal(recallAtK(['a'], mkChunks('a', 'a', 'a'), 3), 1)
  })

  test('should credit a duplicated relevant doc at its best rank for ndcgAtK', () => {
    assert.equal(round(ndcgAtK(['a'], mkChunks('x', 'a', 'a'), 3), 3), 0.631)
    assert.equal(ndcgAtK(['a'], mkChunks('a', 'a', 'b'), 3), 1)
  })

  test('should return the fraction of relevant docs found within k for recallAtK', () => {
    const rel = ['a', 'b', 'c']
    const ret = mkChunks('a', 'b', 'x', 'c')

    assert.equal(recallAtK(rel, ret, 2), 2 / 3)
  })

  describe('round', () => {
    test('should be deterministic on exact halves', () => {
      assert.equal(round(0.005, 2), 0.01)
      assert.equal(round(0.125, 2), 0.13)
      assert.equal(round(0.6510, 3), 0.651)
    })

    test('should be symmetric for negatives and never produce -0', () => {
      assert.equal(round(-0.005, 2), -0.01)
      assert.equal(round(-0.015, 2), -0.02)
      assert.equal(round(-0.025, 2), -0.03)
      assert.ok(!Object.is(round(-0.004, 2), -0))
      assert.equal(round(-0.004, 2), 0)
    })
  })

  describe('when the relevant set is empty', () => {
    test('should return 0 for recallAtK', () => {
      assert.equal(recallAtK([], mkChunks('a'), 5), 0)
    })

    test('should return 0 for ndcgAtK', () => {
      assert.equal(ndcgAtK([], mkChunks('a'), 5), 0)
    })

    test('should return 0 for mean of an empty array', () => {
      assert.equal(mean([]), 0)
    })
  })

  describe('with OR-groups', () => {
    describe('when one alternate is retrieved', () => {
      const rel = [['a1', 'a2']]
      const ret = mkChunks('x', 'a2', 'y')

      test('should credit recallAtK once for the group', () => {
        assert.equal(recallAtK(rel, ret, 5), 1)
      })

      test('should credit hitRateAtK once for the group', () => {
        assert.equal(hitRateAtK(rel, ret, 5), 1)
      })

      test('should use the rank of the matched alternate for mrr', () => {
        assert.equal(mrr(rel, ret, 5), 1 / 2)
      })

      test('should use the rank of the matched alternate for ndcgAtK', () => {
        assert.equal(round(ndcgAtK(rel, ret, 5), 3), round(1 / Math.log2(3), 3))
      })
    })

    describe('when both alternates are retrieved', () => {
      const rel = [['a1', 'a2']]
      const ret = mkChunks('a1', 'a2', 'x')

      test('should credit recallAtK once, not twice', () => {
        assert.equal(recallAtK(rel, ret, 5), 1)
      })

      test('should score ndcgAtK at the best rank only', () => {
        assert.equal(ndcgAtK(rel, ret, 5), 1)
      })
    })

    describe('when no alternate is retrieved', () => {
      const rel = [['a1', 'a2']]
      const ret = mkChunks('x', 'y', 'z')

      test('should return 0 for recallAtK', () => {
        assert.equal(recallAtK(rel, ret, 5), 0)
      })

      test('should return 0 for mrr', () => {
        assert.equal(mrr(rel, ret, 5), 0)
      })

      test('should return 0 for hitRateAtK', () => {
        assert.equal(hitRateAtK(rel, ret, 5), 0)
      })

      test('should return 0 for ndcgAtK', () => {
        assert.equal(ndcgAtK(rel, ret, 5), 0)
      })
    })

    test('should record all slot ranks for relevantHitsAtRank even when alternates span multiple slots', () => {
      const rel = [['a1', 'a2']]
      const ret = mkChunks('x', 'a1', 'y', 'a2', 'z')

      assert.deepEqual(relevantHitsAtRank(rel, ret, 5), [2, 4])
    })

    test('should use the earliest alternate rank for mrr and hitRateAtK', () => {
      const rel = [['a1', 'a2', 'a3']]
      const ret = mkChunks('x', 'a3', 'y', 'a1', 'z')

      assert.equal(hitRateAtK(rel, ret, 5), 1)
      assert.equal(mrr(rel, ret, 5), 1 / 2)
    })

    test('should use the best rank for ndcgAtK when alternates appear in different order', () => {
      const rel = [['a1', 'a2']]
      const ret = mkChunks('x', 'a2', 'y', 'a1', 'z')

      assert.equal(round(ndcgAtK(rel, ret, 5), 6), round(1 / Math.log2(3), 6))
    })

    describe('with mixed plain ids and OR-groups', () => {
      test('should return recall 1/2 when only the plain id is found', () => {
        const rel = ['plain', ['a1', 'a2']]
        const ret = mkChunks('plain', 'x', 'y')

        assert.equal(recallAtK(rel, ret, 5), 1 / 2)
        assert.equal(hitRateAtK(rel, ret, 5), 1)
        assert.equal(mrr(rel, ret, 5), 1)
      })

      test('should return recall 1 when both groups are found via different alternates', () => {
        const rel = ['plain', ['a1', 'a2']]
        const ret = mkChunks('a2', 'plain', 'x')
        const idcg = 1 + 1 / Math.log2(3)
        const dcg = 1 + 1 / Math.log2(3)

        assert.equal(recallAtK(rel, ret, 5), 1)
        assert.equal(round(ndcgAtK(rel, ret, 5), 3), round(dcg / idcg, 3))
      })

      test('should return recall 1 when both alternates of the OR-group are retrieved alongside a plain hit', () => {
        const rel = ['plain', ['a1', 'a2']]
        const ret = mkChunks('plain', 'a1', 'a2', 'x', 'y')

        assert.equal(recallAtK(rel, ret, 5), 1)
      })
    })

    test('should return recall 1 for a three-alternate group when only the middle alternate is retrieved', () => {
      const rel = [['a1', 'a2', 'a3']]
      const ret = mkChunks('x', 'a2', 'y', 'z', 'q')

      assert.equal(recallAtK(rel, ret, 5), 1)
      assert.equal(mrr(rel, ret, 5), 1 / 2)
    })

    test('should score each of two OR-groups once when both are fully retrieved', () => {
      const rel = [['a1', 'a2'], ['b1', 'b2']]
      const ret = mkChunks('a1', 'a2', 'b1', 'b2', 'x')
      const dcg = 1 + 1 / Math.log2(4)
      const idcg = 1 + 1 / Math.log2(3)

      assert.equal(recallAtK(rel, ret, 5), 1)
      assert.equal(round(ndcgAtK(rel, ret, 5), 3), round(dcg / idcg, 3))
    })

    test('should not double-count when one slot contains both alternates of the same group', () => {
      const rel = [['a1', 'a2']]
      const ret = [{ ids: ['a1', 'a2'], text: '' }, { ids: ['x'], text: '' }]

      assert.equal(recallAtK(rel, ret, 5), 1)
      assert.equal(ndcgAtK(rel, ret, 5), 1)
    })

    test('should credit both groups when one slot contains ids from two different groups', () => {
      const rel = [['a1'], ['b1', 'b2']]
      const ret = [{ ids: ['a1', 'b2'], text: '' }, { ids: ['x'], text: '' }]

      assert.equal(recallAtK(rel, ret, 5), 1)
    })
  })

  describe('side-effects', () => {
    test('should not add properties to retrieved chunk objects', () => {
      const chunk = { ids: ['a'], text: 'body' }
      const keysBefore = Object.keys(chunk)

      recallAtK(['a'], [chunk], 3)

      assert.deepEqual(Object.keys(chunk), keysBefore)
    })
  })
})
