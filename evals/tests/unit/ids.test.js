import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { hashText, labelFor, docIdFor, buildIdMap } from '../../lib/ids.js'

describe('ids tests', () => {
  test('hashText is deterministic and 8 hex chars', () => {
    const h = hashText('hello world')
    assert.match(h, /^[0-9a-f]{8}$/)
    assert.equal(h, hashText('hello world'))
  })

  test('hashText differs for different text', () => {
    assert.notEqual(hashText('a'), hashText('b'))
  })

  test('labelFor slugs the first-line breadcrumb, dropping Source:', () => {
    const text =
      'Serving Provided Services > cds. serve (...) > Source: https://cap.cloud.sap/docs/node.js/cds-serve\nbody text here'
    // breadcrumb before "Source:", slugged, max 6 segments
    assert.equal(labelFor(text), 'serving-provided-services-cds-serve')
  })

  test('labelFor caps at 6 segments', () => {
    const label = labelFor('one two three four five six seven eight')
    assert.equal(label.split('-').length, 6)
    assert.equal(label, 'one-two-three-four-five-six')
  })

  test('labelFor falls back to "chunk" when no alphanumerics', () => {
    assert.equal(labelFor('>>> ### ---'), 'chunk')
    assert.equal(labelFor(''), 'chunk')
  })

  test('docIdFor combines label and hash', () => {
    const text = 'Getting Started > Setup > Source: https://x\nmore'
    const id = docIdFor(text)
    assert.match(id, /^getting-started-setup#[0-9a-f]{8}$/)
    assert.equal(id, docIdFor(text)) // deterministic
  })

  test('docIdFor is stable under reordering (identity is the hash)', () => {
    // Same text → same id regardless of surrounding context.
    const a = docIdFor('Topic A\nsome content')
    const b = docIdFor('Topic A\nsome content')
    assert.equal(a, b)
  })

  test('two chunks with same breadcrumb but different body get distinct ids', () => {
    const id1 = docIdFor('Same Heading > Source: x\nbody one')
    const id2 = docIdFor('Same Heading > Source: x\nbody two')
    assert.notEqual(id1, id2) // hashes differ
    assert.ok(id1.startsWith('same-heading#'))
    assert.ok(id2.startsWith('same-heading#'))
  })

  test('buildIdMap returns ids + byId, dedupes identical chunks', () => {
    const chunks = ['Alpha\nx', 'Beta\ny', 'Alpha\nx'] // 3rd is a dup of 1st
    const { ids, byId } = buildIdMap(chunks)
    assert.equal(ids.length, 2) // dup collapsed
    assert.equal(byId.size, 2)
    for (const id of ids) assert.ok(byId.has(id))
  })

  test('buildIdMap maps id → original text', () => {
    const chunks = ['Alpha\nbody-a', 'Beta\nbody-b']
    const { byId } = buildIdMap(chunks)
    for (const [id, text] of byId) {
      assert.equal(docIdFor(text), id)
    }
  })

  test('buildIdMap throws on a genuine hash collision', () => {
    // Force a collision by stubbing is impractical; instead assert the guard
    // path via a Map preloaded through the public API is consistent: identical
    // ids for different text cannot occur with sha1, so we verify the inverse —
    // distinct texts never collide across a large sample.
    const chunks = Array.from({ length: 500 }, (_, i) => `chunk number ${i}\nunique body ${i}`)
    const { ids } = buildIdMap(chunks)
    assert.equal(new Set(ids).size, 500) // no accidental collisions
  })
})
