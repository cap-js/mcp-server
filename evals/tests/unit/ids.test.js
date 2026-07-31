import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseId, buildIdMap } from '../../lib/ids.js'

describe('ids tests', () => {
  test('parseId builds <url>#<breadcrumb-slug> from the first line', () => {
    const text =
      'Serving Provided Services > cds. serve (...) > Source: https://cap.cloud.sap/docs/node.js/cds-serve\nbody text here'
    assert.equal(
      parseId(text),
      'https://cap.cloud.sap/docs/node.js/cds-serve#serving-provided-services-cds-serve'
    )
  })

  test('parseId is deterministic (pure string parse)', () => {
    const text = 'Getting Started > Setup > Source: https://x/y\nmore'
    assert.equal(parseId(text), parseId(text))
    assert.equal(parseId(text), 'https://x/y#getting-started-setup')
  })

  test('parseId ignores the body — same first line, different body → same id', () => {
    const a = parseId('Heading A > Source: https://x/p\nbody one')
    const b = parseId('Heading A > Source: https://x/p\nbody two')
    assert.equal(a, b)
    assert.equal(a, 'https://x/p#heading-a')
  })

  test('parseId falls back to nourl# when there is a breadcrumb but no Source URL', () => {
    assert.equal(parseId('Node.js and cds-dk\nsome text'), 'nourl#node-js-and-cds-dk')
  })

  test('parseId returns null when there is neither URL nor slug-able text', () => {
    assert.equal(parseId('>>> ### ---'), null)
    assert.equal(parseId(''), null)
  })

  test('parseId slug drops the Source: portion and normalises punctuation', () => {
    const id = parseId('A/B & C > D! > Source: https://x/z\nbody')
    assert.equal(id, 'https://x/z#a-b-c-d')
  })

  test('buildIdMap returns distinct ids + a Set, collapsing same-id chunks', () => {
    const chunks = [
      'Alpha > Source: https://x/a\nbody 1',
      'Beta > Source: https://x/b\nbody 2',
      'Alpha > Source: https://x/a\nbody 3' // same first line as #1 → same id
    ]
    const { ids, idSet } = buildIdMap(chunks)
    assert.equal(ids.length, 2) // duplicate id collapsed
    assert.equal(idSet.size, 2)
    assert.ok(idSet.has('https://x/a#alpha'))
    assert.ok(idSet.has('https://x/b#beta'))
  })

  test('buildIdMap skips chunks with no parseable id', () => {
    const chunks = ['Good > Source: https://x/g\nbody', '>>> ###']
    const { ids } = buildIdMap(chunks)
    assert.deepEqual(ids, ['https://x/g#good'])
  })

  test('buildIdMap keeps distinct sections of the same page as distinct ids', () => {
    const chunks = [
      'Auth > Role-Based > Source: https://x/auth\nbody',
      'Auth > Instance-Based > Source: https://x/auth\nbody'
    ]
    const { ids } = buildIdMap(chunks)
    assert.equal(ids.length, 2) // same URL, different breadcrumb → different id
    assert.ok(ids.every(id => id.startsWith('https://x/auth#')))
  })
})
