import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseId, buildIdMap } from '../../lib/ids.js'

describe('ids tests', () => {
  test('parseId is the Source: URL from the first line (with its #section anchor)', () => {
    const text =
      'Getting Started > Initial Setup > Source: https://cap.cloud.sap/docs/get-started/#initial-setup\nbody text here'
    assert.equal(parseId(text), 'https://cap.cloud.sap/docs/get-started/#initial-setup')
  })

  test('parseId is deterministic (pure string parse)', () => {
    const text = 'Getting Started > Setup > Source: https://x/y#setup\nmore'
    assert.equal(parseId(text), parseId(text))
    assert.equal(parseId(text), 'https://x/y#setup')
  })

  test('parseId ignores the body and breadcrumb — same URL → same id', () => {
    const a = parseId('Heading A > Source: https://x/p#s\nbody one')
    const b = parseId('Different Heading > Source: https://x/p#s\nbody two')
    assert.equal(a, b)
    assert.equal(a, 'https://x/p#s')
  })

  test('parseId throws when there is no Source: URL', () => {
    assert.throws(() => parseId('Node.js and cds-dk\nsome text'), /no "Source:" URL/)
    assert.throws(() => parseId('>>> ### ---'), /no "Source:" URL/)
    assert.throws(() => parseId(''), /no "Source:" URL/)
  })

  test('buildIdMap returns distinct ids + a Set, collapsing same-url chunks', () => {
    const chunks = [
      'Alpha > Source: https://x/a#alpha\nbody 1',
      'Beta > Source: https://x/b#beta\nbody 2',
      'Alpha again > Source: https://x/a#alpha\nbody 3' // same URL → same id
    ]
    const { ids, idSet } = buildIdMap(chunks)
    assert.equal(ids.length, 2) // duplicate id collapsed
    assert.equal(idSet.size, 2)
    assert.ok(idSet.has('https://x/a#alpha'))
    assert.ok(idSet.has('https://x/b#beta'))
  })

  test('buildIdMap throws if any chunk has no parseable id', () => {
    const chunks = ['Good > Source: https://x/g#good\nbody', '>>> ### (no source url)']
    assert.throws(() => buildIdMap(chunks), /no "Source:" URL/)
  })

  test('buildIdMap keeps distinct sections of the same page as distinct ids', () => {
    const chunks = [
      'Auth > Role-Based > Source: https://x/auth#role-based\nbody',
      'Auth > Instance-Based > Source: https://x/auth#instance-based\nbody'
    ]
    const { ids } = buildIdMap(chunks)
    assert.equal(ids.length, 2) // same page, different #anchor → different id
    assert.ok(ids.every(id => id.startsWith('https://x/auth#')))
  })
})
