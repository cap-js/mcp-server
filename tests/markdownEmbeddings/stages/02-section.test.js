import { it, describe } from 'node:test'
import assert from 'node:assert'
import { sectionize } from '../../../lib/markdownEmbeddings/chunker/stages/02-buildSections.js'

function node(title, source, body, depth, children = []) {
  return {
    title,
    source,
    body,
    depth,
    raw: '#'.repeat(depth) + ' ' + title,
    children
  }
}

describe('sectionize', () => {
  describe('given a parsed node tree', () => {
    it('should return an empty array for an empty nodes input', () => {
      assert.deepStrictEqual(sectionize([], {}), [])
    })

    it('should produce one section from a single leaf node', () => {
      const n = node('Title', '> Source: /docs/title', 'Body text.', 1)
      const [s] = sectionize([n], {})
      assert.strictEqual(s.heading, '# Title')
      assert.strictEqual(s.depth, 1)
      assert.deepStrictEqual(s.headingPath, ['Title'])
      assert.ok(s.source.includes('/docs/title'))
      assert.ok(s.body.includes('Body text.'))
      assert.ok(!s.body.includes('> Source:'), 'source line not in body')
    })

    it("should set source to the raw '> Source:' line", () => {
      const n = node('A', '> Source: /docs/path', 'Body.', 1)
      const [s] = sectionize([n], {})
      assert.strictEqual(s.source, '> Source: /docs/path')
    })

    it('should set source to empty string when node has no source line', () => {
      const n = node('A', '', 'No source here.\nJust content.', 1)
      const [s] = sectionize([n], {})
      assert.strictEqual(s.source, '')
      assert.ok(s.body.includes('No source here.'))
    })

    it('should set depth to match the heading depth', () => {
      const n = node('H3', '> Source: /a', 'body', 3)
      const [s] = sectionize([n], {})
      assert.strictEqual(s.depth, 3)
    })

    it('should set heading to the raw heading line', () => {
      const n = node('My Title', '> Source: /a', 'body', 2)
      const [s] = sectionize([n], {})
      assert.strictEqual(s.heading, '## My Title')
    })
  })

  describe('when sectionizing a tree', () => {
    it('should produce sections for both parent and child in depth-first order', () => {
      const child = node('Child', '> Source: /docs/a#child', 'Child body.', 2)
      const parent = node('Parent', '> Source: /docs/a', 'Parent body.', 1, [child])
      const sections = sectionize([parent], {})
      assert.strictEqual(sections.length, 2)
      assert.strictEqual(sections[0].heading, '# Parent')
      assert.strictEqual(sections[1].heading, '## Child')
    })

    it('should emit sections in depth-first order', () => {
      const gc = node('GC', '> Source: /c', 'body', 3)
      const ch = node('Child', '> Source: /b', 'body', 2, [gc])
      const pa = node('Parent', '> Source: /a', 'body', 1, [ch])
      const sections = sectionize([pa], {})
      assert.deepStrictEqual(
        sections.map((s) => s.heading),
        ['# Parent', '## Child', '### GC']
      )
    })

    it('should emit all sections when there are multiple roots', () => {
      const a = node('A', '> Source: /a', 'body', 1)
      const b = node('B', '> Source: /b', 'body', 1)
      const sections = sectionize([a, b], {})
      assert.strictEqual(sections.length, 2)
      assert.strictEqual(sections[0].heading, '# A')
      assert.strictEqual(sections[1].heading, '# B')
    })
  })

  describe('when building headingPath', () => {
    it('should set headingPath to [title] for a root node', () => {
      const n = node('Root', '> Source: /a', 'body', 1)
      const [s] = sectionize([n], {})
      assert.deepStrictEqual(s.headingPath, ['Root'])
    })

    it('should extend parent headingPath for a child node', () => {
      const ch = node('Child', '> Source: /a#child', 'body', 2)
      const pa = node('Parent', '> Source: /a', 'body', 1, [ch])
      const sections = sectionize([pa], {})
      assert.deepStrictEqual(sections[1].headingPath, ['Parent', 'Child'])
    })

    it('should include all ancestors in headingPath for a grandchild', () => {
      const gc = node('GC', '> Source: /c', 'body', 3)
      const ch = node('Child', '> Source: /b', 'body', 2, [gc])
      const pa = node('Parent', '> Source: /a', 'body', 1, [ch])
      const sections = sectionize([pa], {})
      assert.deepStrictEqual(sections[2].headingPath, ['Parent', 'Child', 'GC'])
    })

    it('should not add to headingPath when node title is empty', () => {
      const child = node('Real', '> Source: /b', 'body', 2)
      const preamble = {
        title: '',
        source: '',
        body: '',
        depth: 0,
        raw: '',
        children: [child]
      }
      const sections = sectionize([preamble], {})
      assert.deepStrictEqual(sections[1].headingPath, ['Real'])
    })
  })

  describe('when a node has an empty body', () => {
    it('should not skip an empty-body node that has children', () => {
      const ch = node('Child', '> Source: /a#child', 'body', 2)
      const pa = node('Parent', '> Source: /a', '', 1, [ch])
      const sections = sectionize([pa], {})
      // pa has children → not a loner → both emitted
      assert.strictEqual(sections.length, 2)
      assert.strictEqual(sections[0].heading, '# Parent')
      assert.strictEqual(sections[1].heading, '## Child')
    })

    it('should keep an empty-body node when a later same-depth sibling has content', () => {
      const a = node('A', '> Source: /a', '', 1)
      const b = node('B', '> Source: /b', 'real content', 1)
      const sections = sectionize([a, b], {})
      assert.strictEqual(sections.length, 2)
      assert.strictEqual(sections[0].heading, '# A')
      assert.strictEqual(sections[1].heading, '# B')
    })

    it('should always emit a node with non-empty body even with no same-depth siblings', () => {
      const n = node('A', '> Source: /a', 'some content', 1)
      const sections = sectionize([n], {})
      assert.strictEqual(sections.length, 1)
    })
  })

  describe('when maxHeadingDepth is applied', () => {
    it('should fold a node deeper than maxHeadingDepth into its nearest in-scope ancestor', () => {
      const deep = node('Deep', '> Source: /a#deep', 'Deep body.', 3)
      const parent = node('Parent', '> Source: /a', 'Parent body.', 2, [deep])
      const sections = sectionize([parent], { maxHeadingDepth: 2 })
      assert.strictEqual(sections.length, 1)
      assert.strictEqual(sections[0].heading, '## Parent')
      assert.ok(sections[0].body.includes('Parent body.'))
      assert.ok(sections[0].body.includes('Deep body.'))
    })

    it('should emit only the parent section when the over-limit child body is empty', () => {
      const deep = node('My Section', '> Source: /a#sec', '', 3)
      const parent = node('Parent', '> Source: /a', '', 2, [deep])
      const sections = sectionize([parent], { maxHeadingDepth: 2 })
      // parent has children → not a loner → emitted; deep folds into parent
      assert.strictEqual(sections.length, 1)
      assert.strictEqual(sections[0].body, '')
    })

    it('should fold all over-limit nodes and their children into the same in-scope ancestor', () => {
      const gc = node('GC', '> Source: /a#gc', 'GC body.', 4)
      const deep = node('Deep', '> Source: /a#deep', 'Deep body.', 3, [gc])
      const parent = node('Parent', '> Source: /a', 'Parent body.', 2, [deep])
      const sections = sectionize([parent], { maxHeadingDepth: 2 })
      assert.strictEqual(sections.length, 1)
      assert.ok(sections[0].body.includes('Parent body.'))
      assert.ok(sections[0].body.includes('Deep body.'))
      assert.ok(sections[0].body.includes('GC body.'))
    })

    it('should produce its own section for an in-limit child after an over-limit sibling', () => {
      const over = node('Over', '> Source: /a#over', 'Over body.', 3)
      const inlimit = node('InLimit', '> Source: /a#inlimit', 'In body.', 2)
      const root = node('Root', '> Source: /a', 'body', 1, [over, inlimit])
      const sections = sectionize([root], { maxHeadingDepth: 2 })
      assert.strictEqual(sections.length, 2)
      assert.strictEqual(sections[0].heading, '# Root')
      assert.strictEqual(sections[1].heading, '## InLimit')
      assert.ok(sections[0].body.includes('Over body.'))
      assert.ok(sections[1].body.includes('In body.'))
    })

    it('should not crash when root node depth exceeds maxHeadingDepth', () => {
      const deepRoot = node('Deep Root', '> Source: /docs/a#deep', 'content', 5)
      assert.doesNotThrow(
        () => sectionize([deepRoot], { maxHeadingDepth: 4 }),
        'sectionize must not crash when root node depth exceeds maxHeadingDepth'
      )
    })

    it('should not silently lose body content when root node depth exceeds maxHeadingDepth', () => {
      const deepRoot = node('Deep Root', '> Source: /docs/a#deep', 'important content', 5)
      let sections
      try {
        sections = sectionize([deepRoot], { maxHeadingDepth: 4 })
      } catch {
        assert.fail('sectionize threw for root node with depth > maxHeadingDepth')
      }
      const allBody = sections.map((s) => s.body).join('\n')
      assert.ok(
        allBody.includes('important content'),
        `content of deep root node lost after sectionize. sections: ${JSON.stringify(sections)}`
      )
    })

    it('should emit a node at exactly maxHeadingDepth without folding it', () => {
      const child = node('Deep', '> Source: /a#d', 'deep body', 3)
      const parent = node('Top', '> Source: /a', 'top body', 1, [child])
      const sections = sectionize([parent], { maxHeadingDepth: 3 })
      assert.strictEqual(sections.length, 2)
      assert.strictEqual(sections[1].heading, '### Deep')
      assert.ok(sections[1].body.includes('deep body'))
    })

    it('should append both over-limit sibling bodies to the ancestor body in document order', () => {
      const s1 = node('S1', '> Source: /a#1', 'body one', 3)
      const s2 = node('S2', '> Source: /a#2', 'body two', 3)
      const parent = node('P', '> Source: /a', 'parent body', 1, [s1, s2])
      const [section] = sectionize([parent], { maxHeadingDepth: 2 })
      assert.strictEqual(section.headingPath[0], 'P')
      const b = section.body
      const i1 = b.indexOf('body one')
      const i2 = b.indexOf('body two')
      assert.ok(i1 !== -1 && i2 !== -1, 'both bodies must appear')
      assert.ok(i1 < i2, 'S1 body must precede S2 body')
      assert.ok(b.includes('### S1'))
      assert.ok(b.includes('### S2'))
    })

    it('should drop an over-limit node with empty body from the ancestor body', () => {
      const deep = node('OnlyHeading', '> Source: /a#h', '', 3)
      const parent = node('P', '> Source: /a', 'parent body', 1, [deep])
      const [section] = sectionize([parent], { maxHeadingDepth: 2 })
      assert.strictEqual(section.body, 'parent body')
      assert.doesNotMatch(section.body, /###\s+OnlyHeading\n\n\n/)
    })
  })

  describe('when checking referential safety', () => {
    it('should not pollute a sibling headingPath from an earlier sibling', () => {
      const a = node('A', '> Source: /a', 'a body', 2)
      const b = node('B', '> Source: /b', 'b body', 2)
      const parent = node('Root', '> Source: /r', 'root body', 1, [a, b])
      const sections = sectionize([parent], {})
      const aSec = sections.find((s) => s.heading === '## A')
      const bSec = sections.find((s) => s.heading === '## B')
      assert.deepStrictEqual(aSec.headingPath, ['Root', 'A'])
      assert.deepStrictEqual(bSec.headingPath, ['Root', 'B'])
    })
  })
})
