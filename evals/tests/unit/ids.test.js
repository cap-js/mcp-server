import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseId, buildIdMap, buildTextMap, resolveIds } from '../../lib/ids.js'

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

  test('parseId returns null when there is no Source: URL', () => {
    assert.equal(parseId('Node.js and cds-dk\nsome text'), null)
    assert.equal(parseId('>>> ### ---'), null)
    assert.equal(parseId(''), null)
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

  test('buildIdMap synthesizes #generated-anker-N ids for URL-less continuation chunks', () => {
    const chunks = [
      'Setup > Source: https://x/setup#brew\ninstall homebrew',
      'more brew install steps', // continuation of the previous page
      'and even more steps', // second continuation
      'Next > Source: https://x/next#go\ndifferent page'
    ]
    const { ids } = buildIdMap(chunks)
    assert.deepEqual(ids, [
      'https://x/setup#brew',
      'https://x/setup#generated-anker-1',
      'https://x/setup#generated-anker-2',
      'https://x/next#go'
    ])
  })

  test('buildIdMap drops a leading URL-less chunk (no page to inherit from)', () => {
    const chunks = ['orphan continuation with no predecessor', 'Good > Source: https://x/g#good\nbody']
    const { ids } = buildIdMap(chunks)
    assert.deepEqual(ids, ['https://x/g#good'])
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

  test('buildTextMap maps every id (incl. generated-anker) back to its chunk text', () => {
    const chunks = [
      'Setup > Source: https://x/setup#brew\ninstall homebrew',
      'more brew install steps'
    ]
    const map = buildTextMap(chunks)
    assert.equal(map.get('https://x/setup#brew'), chunks[0])
    assert.equal(map.get('https://x/setup#generated-anker-1'), chunks[1])
  })

  test('resolveIds keeps every retrieved slot (URL-less chunk not dropped)', () => {
    // Mirrors the capire-4 case: a continuation chunk among the top results must
    // NOT shrink the list below k.
    const retrieved = [
      'A > Source: https://x/a#s\nbody',
      'B > Source: https://x/b#s\nbody',
      'Timestamps', // URL-less continuation
      'C > Source: https://x/c#s\nbody'
    ]
    const { ids, texts } = resolveIds(retrieved, []) // empty corpus → falls back to local ids
    assert.equal(ids.length, 4) // slot preserved
    assert.deepEqual(ids, ['https://x/a#s', 'https://x/b#s', 'https://x/b#generated-anker-1', 'https://x/c#s'])
    assert.deepEqual(texts, retrieved) // per-slot text aligned with ids
  })

  test('resolveIds matches a URL-less chunk to its true corpus generated-anker id by text', () => {
    // Corpus: page P has a real section then a continuation chunk ("Timestamps").
    const corpus = [
      'P > Real > Source: https://x/p#real\nreal section body',
      'Timestamps' // → corpus id https://x/p#generated-anker-1
    ]
    // Retrieved elsewhere, the same continuation text appears after a DIFFERENT page.
    const retrieved = ['Q > Source: https://x/q#s\nother', 'Timestamps']
    const { ids } = resolveIds(retrieved, corpus)
    // The continuation resolves to its CORPUS id (p#generated-anker-1), not the retrieval-local q#generated-anker-1.
    assert.deepEqual(ids, ['https://x/q#s', 'https://x/p#generated-anker-1'])
  })

  test('resolveIds keeps distinct per-slot text for two slots sharing an id', () => {
    // A page split into two chunks emits the same first-line/id but different bodies.
    const retrieved = [
      'Domain > Primary Keys > Source: https://x/d#pk\nbody one',
      'Domain > Primary Keys > Source: https://x/d#pk\nbody two'
    ]
    const { ids, texts } = resolveIds(retrieved, [])
    assert.deepEqual(ids, ['https://x/d#pk', 'https://x/d#pk']) // same id, both slots
    assert.notEqual(texts[0], texts[1]) // but distinct text per slot
    assert.deepEqual(texts, retrieved)
  })

  test('resolveIds does not dedup — repeated page fills repeated slots', () => {
    const retrieved = ['P > Source: https://x/p#s\n1', 'P again > Source: https://x/p#s\n2']
    assert.deepEqual(resolveIds(retrieved, []).ids, ['https://x/p#s', 'https://x/p#s'])
  })
})
