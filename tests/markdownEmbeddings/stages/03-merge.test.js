import { it, describe } from 'node:test'
import assert from 'node:assert'
import { mergeSections } from '../../../lib/markdownEmbeddings/chunker/stages/03-mergeSections.js'

const cfg = { maxTokens: 1000, minChunkSize: 100 }

function sec(body, overrides = {}) {
  return {
    heading: 'H',
    headingPath: ['H'],
    source: '',
    depth: 1,
    body,
    ...overrides
  }
}

describe('mergeSections', () => {
  describe('given trivial inputs', () => {
    it('should return an empty array for empty input', () => {
      assert.deepStrictEqual(mergeSections([], cfg), [])
    })

    it('should pass a single section through unchanged', () => {
      const s = sec('Hello world.')
      assert.deepStrictEqual(mergeSections([s], cfg), [s])
    })

    it('should not merge sections when both have a body', () => {
      const a = sec('First section.')
      const b = sec('Second section.')
      assert.strictEqual(mergeSections([a, b], cfg).length, 2)
    })
  })

  describe('when a section has an empty body', () => {
    it('should absorb an empty-body section into the following same-depth non-empty section', () => {
      const empty = sec('', { depth: 2, heading: '## A' })
      const full = sec('Content here.', { depth: 2, heading: '## B' })
      const result = mergeSections([empty, full], cfg)
      assert.strictEqual(result.length, 1)
      assert.ok(result[0].body.includes('Content here.'))
      assert.ok(result[0].heading.includes('## B'))
    })

    it('should absorb an empty-body section at depth 1 with no depth restriction', () => {
      const empty = sec('', { depth: 1, heading: '# A' })
      const full = sec('Content.', { depth: 1, heading: '# B' })
      const result = mergeSections([empty, full], cfg)
      assert.strictEqual(result.length, 1)
      assert.ok(result[0].body.includes('Content.'))
    })

    it('should not absorb an empty-body section when the next section is deeper', () => {
      const empty = sec('', { depth: 2, heading: '## A' })
      const deeper = sec('Child content.', { depth: 3, heading: '### B' })
      const result = mergeSections([empty, deeper], cfg)
      assert.strictEqual(result.length, 2)
    })

    it('should absorb multiple consecutive empty-body sections into the next non-empty section', () => {
      const e1 = sec('', { depth: 2, heading: '## A' })
      const e2 = sec('', { depth: 2, heading: '## B' })
      const e3 = sec('', { depth: 2, heading: '## C' })
      const full = sec('Final content.', { depth: 2, heading: '## D' })
      const result = mergeSections([e1, e2, e3, full], cfg)
      assert.strictEqual(result.length, 1)
      const chunk = result[0]
      assert.ok(chunk.body.includes('Final content.'))
      assert.ok(chunk.heading.includes('## A'))
      assert.ok(chunk.heading.includes('## B'))
      assert.ok(chunk.heading.includes('## C'))
      assert.ok(chunk.heading.includes('## D'))
    })

    it('should derive the merged section identity from the target section', () => {
      const empty = sec('', {
        depth: 2,
        heading: '## First',
        headingPath: ['First']
      })
      const full = sec('Body.', {
        depth: 2,
        heading: '## Second',
        headingPath: ['Second']
      })
      const result = mergeSections([empty, full], cfg)
      assert.strictEqual(result[0].heading, '## First\n## Second')
      assert.deepStrictEqual(result[0].headingPath, ['Second'])
    })

    it('should absorb an empty-body section without requiring an anaphoric word', () => {
      // Previously required anaphoric word; now any non-empty next section triggers it
      const empty = sec('', { depth: 2, heading: '## A' })
      const full = sec('Just a regular sentence.', {
        depth: 2,
        heading: '## B'
      })
      const result = mergeSections([empty, full], cfg)
      assert.strictEqual(result.length, 1, 'should merge even without anaphoric word')
    })

    it('should merge a child into the next sibling without touching surrounding chunks', () => {
      const parent = {
        heading: '## Config',
        headingPath: ['Root', 'Config'],
        source: '> Source: /docs/a#config',
        depth: 2,
        body: ''
      }
      const child = {
        heading: '### Option A',
        headingPath: ['Root', 'Config', 'Option A'],
        source: '> Source: /docs/a#option-a',
        depth: 3,
        body: ''
      }
      const child2 = {
        heading: '### Option B',
        headingPath: ['Root', 'Config', 'Option B'],
        source: '> Source: /docs/a#option-b',
        depth: 3,
        body: ''
      }
      const child3 = {
        heading: '### Option C',
        headingPath: ['Root', 'Config', 'Option C'],
        source: '> Source: /docs/a#option-c',
        depth: 3,
        body: 'Set `option_a = true` in the config file.'
      }
      const grandchild = {
        heading: '#### Option Grandchild',
        headingPath: ['Root', 'Config', 'Option A', 'Option Grandchild'],
        source: '> Source: /docs/a#option-grandchild',
        depth: 4,
        body: ''
      }
      const result = mergeSections([parent, child, child2, child3, grandchild], cfg)
      assert.strictEqual(result.length, 3)
      assert.strictEqual(parent, result[0])
      assert.strictEqual(grandchild, result[2])
      assert.deepStrictEqual(result[1], {
        ...child3,
        heading: '### Option A\n### Option B\n### Option C'
      })
    })
  })
})
