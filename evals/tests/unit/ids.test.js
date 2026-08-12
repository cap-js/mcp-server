import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseId, resolveChunkIds, buildIdMap, buildTextMap, resolveIds } from '../../lib/ids.js'

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

  test('parseId finds the chunk\'s own Source: line even when it is not line 1', () => {
    // Real corpus chunks put the Source: a couple of lines below the heading:
    //   "## Initial Setup\n\n> Source: /docs/get-started/#initial-setup"
    const chunk = '## Initial Setup\n\n> Source: /docs/get-started/#initial-setup\nbody'
    assert.equal(parseId(chunk), '/docs/get-started/#initial-setup')
  })

  test('parseId returns null when there is no Source: line at all (no synthetic id)', () => {
    // Malformed chunks are not scored — the eval does not invent ids for them.
    assert.equal(parseId('Getting Started > Initial Setup\nsome text'), null)
    assert.equal(parseId(''), null)
  })

  test('resolveChunkIds: single-section chunk → just its first-line Source', () => {
    const text = 'Domain > Primary Keys\n> Source: /docs/guides/domain#primary-keys\nbody'
    assert.deepEqual(resolveChunkIds(text), ['/docs/guides/domain#primary-keys'])
  })

  test('resolveChunkIds: multi-section chunk collects every in-body Source line', () => {
    const text = [
      '# Getting Started',
      '> Source: /docs/get-started/',
      'intro',
      '## Initial Setup',
      '> Source: /docs/get-started/#initial-setup',
      'setup body',
      '### Node.js and _cds-dk_',
      '> Source: /docs/get-started/#nodejs-and-cds-dk',
      'node body'
    ].join('\n')
    assert.deepEqual(resolveChunkIds(text), [
      '/docs/get-started/',
      '/docs/get-started/#initial-setup',
      '/docs/get-started/#nodejs-and-cds-dk'
    ])
  })

  test('resolveChunkIds: a heading whose Source line was split off is resolved via the tree', () => {
    // The chunk ends right after the heading — its Source line got cut at the
    // chunk boundary. The page-scoped source tree recovers it.
    const text = [
      '## Initial Setup',
      '> Source: /docs/get-started/#initial-setup',
      'setup body',
      '### Node.js and _cds-dk_' // no Source line follows
    ].join('\n')
    const sourceIndex = {
      byHeadingInPage: {
        '/docs/get-started/': { 'node.js and _cds-dk_': '/docs/get-started/#nodejs-and-cds-dk' }
      }
    }
    assert.deepEqual(resolveChunkIds(text, sourceIndex), [
      '/docs/get-started/#initial-setup',
      '/docs/get-started/#nodejs-and-cds-dk'
    ])
  })

  test('resolveChunkIds: without a tree, a split-off heading is simply not credited', () => {
    const text = '## Initial Setup\n> Source: /docs/get-started/#initial-setup\nbody\n### Node.js and _cds-dk_'
    assert.deepEqual(resolveChunkIds(text, null), ['/docs/get-started/#initial-setup'])
  })

  test('resolveChunkIds: no first-line Source → empty', () => {
    assert.deepEqual(resolveChunkIds('breadcrumb only\nbody'), [])
  })

  test('resolveChunkIds dedups repeated sections', () => {
    const text = '## A\n> Source: /docs/p#a\nbody\n## A again\n> Source: /docs/p#a\nmore'
    assert.deepEqual(resolveChunkIds(text), ['/docs/p#a'])
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

  test('buildIdMap drops chunks with no first-line Source: URL', () => {
    const chunks = [
      'Setup > Source: https://x/setup#brew\ninstall homebrew',
      'more brew install steps', // no Source → dropped
      'Next > Source: https://x/next#go\ndifferent page'
    ]
    const { ids } = buildIdMap(chunks)
    assert.deepEqual(ids, ['https://x/setup#brew', 'https://x/next#go'])
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

  test('buildTextMap maps every id back to its chunk text', () => {
    const chunks = [
      'Setup > Source: https://x/setup#brew\ninstall homebrew',
      'Next > Source: https://x/next#go\nbody'
    ]
    const map = buildTextMap(chunks)
    assert.equal(map.get('https://x/setup#brew'), chunks[0])
    assert.equal(map.get('https://x/next#go'), chunks[1])
  })

  test('resolveIds drops URL-less slots, keeps aligned text for the rest', () => {
    const retrieved = [
      'A > Source: https://x/a#s\nbody',
      'B > Source: https://x/b#s\nbody',
      'breadcrumb only', // no Source → dropped
      'C > Source: https://x/c#s\nbody'
    ]
    const { ids, texts } = resolveIds(retrieved, [])
    assert.deepEqual(ids, ['https://x/a#s', 'https://x/b#s', 'https://x/c#s'])
    // texts aligned with the kept ids
    assert.deepEqual(texts, [retrieved[0], retrieved[1], retrieved[3]])
  })

  test('resolveIds keeps distinct per-slot text for two slots sharing an id', () => {
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
