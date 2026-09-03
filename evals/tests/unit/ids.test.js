import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveIds } from '../../lib/ids.js'

const SM = [
  { source: '/docs/get-started/', title: 'Getting Started', depth: 1 },
  { source: '/docs/get-started/#initial-setup', title: 'Initial Setup', depth: 2 },
  { source: '/docs/get-started/#nodejs-and-cds-dk', title: 'Node.js and _cds-dk_', depth: 3 }
]

describe('ids tests', () => {
  test('single chunk with Source: line → one id, text preserved', () => {
    const text = '# Getting Started\n\nSource: /docs/get-started/\nbody'
    const r = resolveIds([text], SM)
    assert.equal(r.length, 1)
    assert.deepEqual(r[0].ids, ['/docs/get-started/'])
    assert.equal(r[0].text, text)
  })

  test('Source: line is matched at position i+2 (one blank line between heading and source)', () => {
    const text = 'Breadcrumb\nbody line\nSource: /docs/a\nmore'
    const r = resolveIds([text], [])
    assert.deepEqual(r[0].ids, ['/docs/a'])
  })

  test('heading lookup via sourceMap when no inline Source: line', () => {
    const text = 'Getting Started\n## Initial Setup\nbody'
    const r = resolveIds([text], SM)
    assert.deepEqual(r[0].ids, ['/docs/get-started/#initial-setup'])
  })

  test('multi-section chunk collects ids from multiple Source: lines', () => {
    const text = [
      '# Getting Started',
      '',
      'Source: /docs/get-started/',
      'intro',
      '## Initial Setup',
      '',
      'Source: /docs/get-started/#initial-setup',
      'setup body'
    ].join('\n')
    const r = resolveIds([text], SM)
    assert.ok(r[0].ids.includes('/docs/get-started/'))
    assert.ok(r[0].ids.includes('/docs/get-started/#initial-setup'))
  })

  test('two independent chunks → two result entries', () => {
    const sm = [{ source: '/a', title: 'A', depth: 1 }, { source: '/b', title: 'B', depth: 1 }]
    const c1 = '# A\n\nSource: /a\nbody'
    const c2 = '# B\n\nSource: /b\nbody'
    const r = resolveIds([c1, c2], sm)
    assert.equal(r.length, 2)
    assert.deepEqual(r[0].ids, ['/a'])
    assert.deepEqual(r[1].ids, ['/b'])
  })

  test('empty chunk (no breadcrumb) → throws', () => {
    assert.throws(() => resolveIds([''], []), /No breadcrumb/)
  })

  test('chunk with breadcrumb but no ids → throws', () => {
    assert.throws(() => resolveIds(['Heading A\nbody\nmore body\nstill no source'], []), /No IDs found/)
  })

  test('empty chunks array → returns empty array', () => {
    assert.deepEqual(resolveIds([], []), [])
  })

  test('breadcrumb-only heading resolved via getSourceByBreadCrump', () => {
    // Two entries share title "Setup" at depth 2 — disambiguation via breadcrumb.
    const sm = [
      { source: '/docs/a/', title: 'A', depth: 1 },
      { source: '/docs/a/#setup', title: 'Setup', depth: 2 },
      { source: '/docs/b/', title: 'B', depth: 1 },
      { source: '/docs/b/#setup', title: 'Setup', depth: 2 }
    ]
    // Chunk is under "B", so breadcrumb should resolve to /docs/b/#setup.
    const text = 'B\n## Setup\nbody'
    const r = resolveIds([text], sm)
    assert.deepEqual(r[0].ids, ['/docs/b/#setup'])
  })
})
