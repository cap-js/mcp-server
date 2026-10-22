import { it, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveIds } from '../../lib/ids.js'

const SM = [
  { source: '/docs/get-started/', title: 'Getting Started', depth: 1 },
  { source: '/docs/get-started/#initial-setup', title: 'Initial Setup', depth: 2 },
  { source: '/docs/get-started/#nodejs-and-cds-dk', title: 'Node.js and _cds-dk_', depth: 3 }
]
const Q = { id: 'q1', question: 'test?' }

describe('ids', () => {
  it('should return one entry with the resolved id and original text for a single chunk', async () => {
    const text = '# Getting Started\n\nSource: /docs/get-started/\nbody'

    const result = await resolveIds([text], Q, SM)

    assert.equal(result.length, 1)
    assert.deepEqual(result[0].ids, ['/docs/get-started/'])
    assert.equal(result[0].text, text)
  })

  it('should resolve the id from a Source line that follows a blank line', async () => {
    const text = '# Section A\n\nSource: /docs/a\nmore'

    const result = await resolveIds([text], Q, [])

    assert.deepEqual(result[0].ids, ['/docs/a'])
  })

  it('should collect ids from all Source lines in a multi-section chunk', async () => {
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

    const result = await resolveIds([text], Q, SM)

    assert.ok(result[0].ids.includes('/docs/get-started/'))
    assert.ok(result[0].ids.includes('/docs/get-started/#initial-setup'))
  })

  it('should return two entries for two independent chunks', async () => {
    const sm = [
      { source: '/a', title: 'A', depth: 1 },
      { source: '/b', title: 'B', depth: 1 }
    ]
    const c1 = '# A\n\nSource: /a\nbody'
    const c2 = '# B\n\nSource: /b\nbody'

    const result = await resolveIds([c1, c2], Q, sm)

    assert.equal(result.length, 2)
    assert.deepEqual(result[0].ids, ['/a'])
    assert.deepEqual(result[1].ids, ['/b'])
  })

  it('should return an empty array when given an empty chunks array', async () => {
    const result = await resolveIds([], Q, [])

    assert.deepEqual(result, [])
  })

  it('should throw "No IDs found" when text has a source prefix but no URL', async () => {
    await assert.rejects(() => resolveIds(['source: '], Q, []), { message: 'No IDs found' })
  })

  describe('side-effects', () => {
    it('should not mutate the question object', async () => {
      const question = { id: 'q1', question: 'test?' }
      const keysBefore = Object.keys(question)

      await resolveIds(['# A\n\nSource: /a\nbody'], question, [])

      assert.deepEqual(Object.keys(question), keysBefore)
    })

    it('should not add properties to source map entries', async () => {
      const entry = { source: '/docs/get-started/', title: 'Getting Started', depth: 1 }
      const keysBefore = Object.keys(entry)

      await resolveIds(['# Getting Started\n\nSource: /docs/get-started/\nbody'], Q, [entry])

      assert.deepEqual(Object.keys(entry), keysBefore)
    })
  })
})
