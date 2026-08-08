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

  test('parseId falls back to a synthetic capire:// URL when there is no Source:', () => {
    // A breadcrumb-only first line → stable synthetic URL from the slug
    assert.equal(parseId('Getting Started > Initial Setup\nsome text'), 'capire://generated/getting-started-initial-setup')
    assert.equal(parseId('Node.js and cds-dk\nsome text'), 'capire://generated/node-js-and-cds-dk')
    // No text at all → null (nothing to derive from)
    assert.equal(parseId(''), null)
    assert.equal(parseId('>>> ### ---'), null) // only punctuation slugifies to empty
  })

  test('parseId still returns the Source: URL when present', () => {
    assert.equal(parseId('X > Source: https://x/y#z\nbody'), 'https://x/y#z')
  })

  test('parseId finds Source: URL in the body when not on the first line', () => {
    // LLM-generated or longer chunks may have the Source: URL anywhere
    const chunk = 'CAP Security > Data Privacy\nsome long description\n> Source: https://cap.cloud.sap/docs/guides/security/#data-privacy\nmore body'
    assert.equal(parseId(chunk), 'https://cap.cloud.sap/docs/guides/security/#data-privacy')
    // Markdown heading style
    const chunk2 = 'Heading\nbody\n# Source: /docs/guides/deploy#section\nmore'
    assert.equal(parseId(chunk2), '/docs/guides/deploy#section')
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

  test('buildIdMap gives breadcrumb-only chunks their own capire:// id', () => {
    // A chunk with a breadcrumb but no Source: URL gets a stable synthetic id
    // derived from the breadcrumb text, not inherited from the predecessor.
    const chunks = [
      'Setup > Source: https://x/setup#brew\ninstall homebrew',
      'more brew install steps', // breadcrumb-only → own capire:// id
      'and even more steps',     // another breadcrumb-only chunk
      'Next > Source: https://x/next#go\ndifferent page'
    ]
    const { ids } = buildIdMap(chunks)
    assert.equal(ids.length, 4)
    assert.equal(ids[0], 'https://x/setup#brew')
    assert.ok(ids[1].startsWith('capire://generated/'))
    assert.ok(ids[2].startsWith('capire://generated/'))
    assert.equal(ids[3], 'https://x/next#go')
    // the two breadcrumb-only chunks have distinct ids (different text → different slug)
    assert.notEqual(ids[1], ids[2])
  })

  test('buildIdMap gives URL-less leading chunks a synthetic capire:// id', () => {
    // With the fallback, breadcrumb-only chunks are no longer dropped.
    const chunks = ['orphan continuation with no predecessor', 'Good > Source: https://x/g#good\nbody']
    const { ids } = buildIdMap(chunks)
    assert.equal(ids.length, 2)
    assert.ok(ids[0].startsWith('capire://generated/'))
    assert.equal(ids[1], 'https://x/g#good')
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

  test('buildTextMap maps every id (incl. capire:// generated) back to its chunk text', () => {
    const chunks = [
      'Setup > Source: https://x/setup#brew\ninstall homebrew',
      'more brew install steps'  // breadcrumb-only → capire://generated/more-brew-install-steps
    ]
    const map = buildTextMap(chunks)
    assert.equal(map.get('https://x/setup#brew'), chunks[0])
    assert.equal(map.get('capire://generated/more-brew-install-steps'), chunks[1])
  })

  test('resolveIds keeps every retrieved slot (URL-less chunk not dropped)', () => {
    // Breadcrumb-only chunks now get a capire:// id, so no slot is dropped.
    const retrieved = [
      'A > Source: https://x/a#s\nbody',
      'B > Source: https://x/b#s\nbody',
      'Timestamps', // breadcrumb-only → capire://generated/timestamps
      'C > Source: https://x/c#s\nbody'
    ]
    const { ids, texts } = resolveIds(retrieved, [])
    assert.equal(ids.length, 4) // slot preserved
    assert.equal(ids[0], 'https://x/a#s')
    assert.equal(ids[1], 'https://x/b#s')
    assert.ok(ids[2].startsWith('capire://generated/'))
    assert.equal(ids[3], 'https://x/c#s')
    assert.deepEqual(texts, retrieved) // per-slot text aligned with ids
  })

  test('resolveIds matches a URL-less chunk to its capire:// corpus id by text', () => {
    // Corpus: page P has a real section then a breadcrumb-only chunk ("Timestamps").
    const corpus = [
      'P > Real > Source: https://x/p#real\nreal section body',
      'Timestamps' // → corpus id capire://generated/timestamps
    ]
    // Retrieved elsewhere, the same breadcrumb-only text appears after a DIFFERENT page.
    const retrieved = ['Q > Source: https://x/q#s\nother', 'Timestamps']
    const { ids } = resolveIds(retrieved, corpus)
    // The chunk resolves to its CORPUS id (capire://generated/timestamps), not local.
    assert.equal(ids[0], 'https://x/q#s')
    assert.ok(ids[1].startsWith('capire://generated/timestamps'))
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
