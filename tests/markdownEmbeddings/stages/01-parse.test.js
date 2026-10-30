import { it, describe } from 'node:test'
import assert from 'node:assert'
import { parse } from '../../../lib/markdownEmbeddings/chunker/stages/01-parse.js'

const config = { maxHeadingDepth: 6 }

describe('parse', () => {
  describe('given basic markdown input', () => {
    it('should yield one root node for a single h1 with body', () => {
      const text = '# Title\n\n> Source: /docs/title\n\nSome body text.'
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].depth, 1)
      assert.strictEqual(roots[0].title, 'Title')
      assert.match(roots[0].body, /Some body text./)
      assert.deepStrictEqual(roots[0].children, [])
    })

    it('should carry required fields with correct types on every node (R06)', () => {
      const text = '# A\n\n> Source: /docs/a\n\nbody\n\n## B\n\n> Source: /docs/a#b\n\nbody b'
      const [a] = parse(text, config)
      for (const node of [a, a.children[0]]) {
        assert.strictEqual(typeof node.depth, 'number')
        assert.strictEqual(typeof node.title, 'string')
        assert.strictEqual(typeof node.raw, 'string')
        assert.ok(Array.isArray(node.children))
        assert.strictEqual(typeof node.source, 'string')
        assert.strictEqual(typeof node.body, 'string')
      }
    })

    it('should assign body lines between headings to the preceding heading (R05)', () => {
      const text =
        '# First\n\n> Source: /docs/first\n\nfirst body\n\n# Second\n\n> Source: /docs/second\n\nsecond body'
      const roots = parse(text, config)
      assert.match(roots[0].body, /first body/)
      assert.doesNotMatch(roots[0].body, /second body/)
      assert.match(roots[1].body, /second body/)
    })

    it('should include trailing lines after the last heading in the last node body (R11)', () => {
      const text = '# Only\n\n> Source: /docs/only\n\nline one\nline two\nline three'
      const [node] = parse(text, config)
      assert.match(node.body, /line one/)
      assert.match(node.body, /line three/)
    })

    it('should produce correct independent nodes for adjacent headings with no body between them (R18)', () => {
      const text = [
        '# First',
        '',
        '> Source: /docs/first',
        '# Second',
        '',
        '> Source: /docs/second',
        '',
        'second body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 2)
      assert.strictEqual(roots[0].title, 'First')
      assert.strictEqual(roots[1].title, 'Second')
      assert.strictEqual(typeof roots[0].body, 'string')
      assert.strictEqual(typeof roots[0].source, 'string')
      assert.strictEqual(typeof roots[1].body, 'string')
    })

    it('should produce a node with empty children and empty body for a single heading with no body lines (R19)', () => {
      const text = '# Solo\n\n> Source: /docs/solo'
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Solo')
      assert.deepStrictEqual(roots[0].children, [])
      assert.strictEqual(typeof roots[0].body, 'string')
    })

    it('should set node.raw to the verbatim heading line with no modification (R16)', () => {
      const headingLine = '## Exact Title Here'
      const text = `# Parent\n\n> Source: /docs/p\n\n${headingLine}\n\n> Source: /docs/p#child\n\nbody`
      const roots = parse(text, config)
      assert.strictEqual(roots[0].children[0].raw, headingLine)
    })

    it('should trim surrounding whitespace from node.title (R30)', () => {
      const text = '##  Padded Title  \n\n> Source: /docs/padded\n\nbody'
      const roots = parse(text, config)
      assert.strictEqual(roots[0].title, 'Padded Title')
    })
  })

  describe('when building the node tree', () => {
    it('should build a correct tree for h1 > h2 > h3 nesting', () => {
      const text =
        '# A\n\n> Source: /docs/a\n\ntop\n\n## B\n\n> Source: /docs/a#b\n\nmid\n\n### C\n\n> Source: /docs/a#c\n\nleaf'
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      const a = roots[0]
      assert.strictEqual(a.title, 'A')
      assert.strictEqual(a.children.length, 1)

      const b = a.children[0]
      assert.strictEqual(b.title, 'B')
      assert.strictEqual(b.depth, 2)
      assert.strictEqual(b.children.length, 1)

      const c = b.children[0]
      assert.strictEqual(c.title, 'C')
      assert.strictEqual(c.depth, 3)
      assert.match(c.body, /leaf/)
      assert.deepStrictEqual(c.children, [])
    })

    it('should produce two h2 children under an h1 with no direct body', () => {
      const text =
        '# Root\n\n> Source: /docs/root\n\n## First\n\n> Source: /docs/root#first\n\none\n\n## Second\n\n> Source: /docs/root#second\n\ntwo'
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      const root = roots[0]
      assert.strictEqual(root.title, 'Root')
      assert.strictEqual(root.children.length, 2)
      assert.strictEqual(root.children[0].title, 'First')
      assert.strictEqual(root.children[1].title, 'Second')
    })

    it('should create a sibling not a child when a shallower heading follows deep nesting (R10)', () => {
      const text = [
        '# Root',
        '',
        '> Source: /docs/root',
        '',
        '## A',
        '',
        '> Source: /docs/root#a',
        '',
        '### A1',
        '',
        '> Source: /docs/root#a1',
        '',
        'deep',
        '',
        '## B',
        '',
        '> Source: /docs/root#b',
        '',
        'sibling'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      const root = roots[0]
      assert.strictEqual(root.children.length, 2)
      assert.strictEqual(root.children[0].title, 'A')
      assert.strictEqual(root.children[1].title, 'B')
      assert.strictEqual(root.children[0].children.length, 1)
      assert.strictEqual(root.children[0].children[0].title, 'A1')
    })

    it('should place H2 as sibling of H3 under H1 when depth skips H1→H3→H2 (R14)', () => {
      const text = [
        '# Root',
        '',
        '> Source: /docs/root',
        '',
        '### Deep',
        '',
        '> Source: /docs/root#deep',
        '',
        'deep body',
        '',
        '## Mid',
        '',
        '> Source: /docs/root#mid',
        '',
        'mid body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      const root = roots[0]
      assert.strictEqual(root.children.length, 2)
      assert.strictEqual(root.children[0].title, 'Deep')
      assert.strictEqual(root.children[0].depth, 3)
      assert.strictEqual(root.children[1].title, 'Mid')
      assert.strictEqual(root.children[1].depth, 2)
      assert.strictEqual(root.children[0].children.length, 0)
    })

    it('should add both H1s to roots when there are two top-level H1s (R15)', () => {
      const text = [
        '# First',
        '',
        '> Source: /docs/first',
        '',
        'body one',
        '',
        '# Second',
        '',
        '> Source: /docs/second',
        '',
        'body two'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 2)
      assert.strictEqual(roots[0].title, 'First')
      assert.strictEqual(roots[1].title, 'Second')
      assert.strictEqual(roots[0].children.length, 0)
      assert.strictEqual(roots[1].children.length, 0)
    })

    it('should add all three top-level headings to roots in document order (R25)', () => {
      const text = [
        '# One',
        '',
        '> Source: /docs/one',
        '',
        '# Two',
        '',
        '> Source: /docs/two',
        '',
        '# Three',
        '',
        '> Source: /docs/three',
        '',
        'body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 3)
      assert.strictEqual(roots[0].title, 'One')
      assert.strictEqual(roots[1].title, 'Two')
      assert.strictEqual(roots[2].title, 'Three')
    })

    it('should form a linear chain for five consecutive deeper headings (R26)', () => {
      const text = [
        '# L1',
        '',
        '> Source: /docs/l1',
        '',
        '## L2',
        '',
        '> Source: /docs/l2',
        '',
        '### L3',
        '',
        '> Source: /docs/l3',
        '',
        '#### L4',
        '',
        '> Source: /docs/l4',
        '',
        '##### L5',
        '',
        '> Source: /docs/l5',
        '',
        'body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      const l2 = roots[0].children[0]
      const l3 = l2.children[0]
      const l4 = l3.children[0]
      const l5 = l4.children[0]
      assert.strictEqual(roots[0].depth, 1)
      assert.strictEqual(l2.depth, 2)
      assert.strictEqual(l3.depth, 3)
      assert.strictEqual(l4.depth, 4)
      assert.strictEqual(l5.depth, 5)
    })

    it('should place a second H1 after deep nesting as a second root not a child (R27)', () => {
      const text = [
        '# First',
        '',
        '> Source: /docs/first',
        '',
        '## A',
        '',
        '> Source: /docs/first#a',
        '',
        '### B',
        '',
        '> Source: /docs/first#b',
        '',
        '#### C',
        '',
        '> Source: /docs/first#c',
        '',
        '# Second',
        '',
        '> Source: /docs/second',
        '',
        'body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 2)
      assert.strictEqual(roots[0].title, 'First')
      assert.strictEqual(roots[1].title, 'Second')
      assert.strictEqual(roots[1].depth, 1)
      assert.strictEqual(roots[1].children.length, 0)
    })

    it('should produce a node with depth 6 for an H6 heading (R23)', () => {
      const text = [
        '# Root',
        '',
        '> Source: /docs/root',
        '',
        '###### Leaf',
        '',
        '> Source: /docs/root#leaf',
        '',
        'deep body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      const leaf = roots[0].children[0]
      assert.strictEqual(leaf.depth, 6)
      assert.strictEqual(leaf.title, 'Leaf')
    })

    it('should place an H2 as a root node when the document starts with H2 (R24)', () => {
      const text = ['## Section', '', '> Source: /docs/section', '', 'body'].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].depth, 2)
      assert.strictEqual(roots[0].title, 'Section')
    })

    it('should set node.depth to match the number of # characters on the heading line (R20)', () => {
      const text = [
        '# H1',
        '',
        '> Source: /docs/h1',
        '',
        '## H2',
        '',
        '> Source: /docs/h2',
        '',
        '#### H4',
        '',
        '> Source: /docs/h4',
        '',
        'body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots[0].depth, 1)
      assert.strictEqual(roots[0].children[0].depth, 2)
      assert.strictEqual(roots[0].children[0].children[0].depth, 4)
    })

    it('should make two consecutive H3s siblings under the same H2 (>= pop at non-root depth)', () => {
      const text = [
        '# H1',
        '',
        '> Source: /docs/a',
        '',
        'top',
        '## H2',
        '',
        '> Source: /docs/a#b',
        '',
        'mid',
        '### First',
        '',
        '> Source: /docs/a#f',
        '',
        'one',
        '### Second',
        '',
        '> Source: /docs/a#s',
        '',
        'two'
      ].join('\n')
      const roots = parse(text, config)
      const h2 = roots[0].children[0]
      assert.strictEqual(h2.children.length, 2)
      assert.strictEqual(h2.children[0].title, 'First')
      assert.strictEqual(h2.children[1].title, 'Second')
    })
  })

  describe('when recognizing source lines', () => {
    it('should treat a heading without > Source: as body text', () => {
      const text = '# Real\n\n> Source: /docs/real\n\nsome body\n\n## No Source Here\n\njust text'
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Real')
      assert.strictEqual(roots[0].children.length, 0)
      assert.match(roots[0].body, /## No Source Here/)
    })

    it('should treat a heading at end of document with no following Source line as body text (R21)', () => {
      const text = [
        '# Real',
        '',
        '> Source: /docs/real',
        '',
        'body',
        '',
        '## No Source At End'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].children.length, 0)
      assert.match(roots[0].body, /## No Source At End/)
    })

    it('should treat a heading as body text when its Source line is 4+ lines after it (R22)', () => {
      const text = [
        '# Real',
        '',
        '> Source: /docs/real',
        '',
        '## Far Source',
        '',
        '',
        '',
        '> Source: /docs/real#far',
        '',
        'body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].children.length, 0)
      assert.match(roots[0].body, /## Far Source/)
    })

    it('should set source and assign empty body to a node that has only a Source line (R28)', () => {
      const text = [
        '# Solo',
        '',
        '> Source: /docs/solo',
        '',
        '# Next',
        '',
        '> Source: /docs/next',
        '',
        'body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 2)
      assert.ok(roots[0].source.includes('/docs/solo'))
      assert.strictEqual(roots[0].body, '')
    })

    it('should not crash when adjacent promoted headings have an empty scan window', () => {
      const text = ['# One', '> Source: /docs/one', '# Two', '> Source: /docs/two'].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 2)
      assert.strictEqual(roots[0].title, 'One')
      assert.strictEqual(roots[1].title, 'Two')
    })
  })

  describe('given a code fence guard', () => {
    it('should not treat a # shell comment inside a code fence as a heading', () => {
      const text =
        '# Real Heading\n\n> Source: /docs/real\n\n```sh\n# install curl\napt-get install curl\n```\n\nafter'
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Real Heading')
      assert.match(roots[0].body, /# install curl/)
    })

    it('should ignore headings inside a ~~~ fence delimiter', () => {
      const text =
        '# Real Heading\n\n> Source: /docs/real\n\n~~~sh\n# install curl\napt-get install curl\n~~~\n\nafter'
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Real Heading')
      assert.match(roots[0].body, /# install curl/)
    })

    it('should recognise indented fence delimiters', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '  ```shell',
        '  # indented comment',
        '  npm install',
        '  ```',
        '',
        'after text'
      ].join('\n')
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Real Heading')
      assert.match(roots[0].body, /# indented comment/)
    })

    it('should recognise a 4-backtick fence and close it with a matching 4-backtick', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '````md',
        '# inside 4-backtick fence',
        '## also inside',
        '````',
        '',
        '## Real Child',
        '',
        '> Source: /docs/real#child',
        '',
        'child body'
      ].join('\n')
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Real Heading')
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Real Child')
    })

    it('should not close the outer fence when ``` is followed by a semicolon', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '```cds [CDS Source]',
        'annotate Books with @sql.append: ```sql',
        '  GROUP TYPE foo',
        '```;',
        "annotate ListOfBooks with @sql.append: 'WITH DDL ONLY';",
        '```',
        '',
        '## Should Be Child Heading',
        '',
        '> Source: /docs/real#child',
        '',
        'child body'
      ].join('\n')
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Real Heading')
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Should Be Child Heading')
    })
  })

  describe('given a container block guard', () => {
    for (const fence of ['```', '~~~', '````']) {
      it(`should recognize a heading between fenced container examples using ${fence}`, () => {
        const text = [
          '# Root',
          'Source: /docs/root',
          `${fence}md`,
          '::: tip',
          '::: note',
          ':::',
          fence,
          '## Real Child',
          'Source: /docs/root#child',
          `${fence}md`,
          ':::',
          fence
        ].join('\n')

        const roots = parse(text)

        assert.strictEqual(roots.length, 1)
        assert.strictEqual(roots[0].children.length, 1)
        assert.strictEqual(roots[0].children[0].title, 'Real Child')
      })
    }

    it('should not close a real outer container with a delimiter inside a fenced example', () => {
      const text = [
        '# Root',
        'Source: /docs/root',
        '::: tip',
        '````md',
        '```md',
        '~~~',
        '```;',
        ':::',
        '````',
        '## Inside',
        'Source: /docs/root#inside',
        ':::',
        '## Outside',
        'Source: /docs/root#outside'
      ].join('\n')

      const roots = parse(text)

      assert.strictEqual(roots.length, 1)
      assert.match(roots[0].body, /## Inside/)
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Outside')
    })

    it('should ignore headings inside all language tabs of a code-group container', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '::: code-group',
        '```shell [macOS]',
        '# macOS install comment',
        'brew install node',
        '```',
        '```shell [Linux]',
        '# Linux install comment',
        'apt install node',
        '```',
        ':::',
        '',
        'after text'
      ].join('\n')
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Real Heading')
      assert.match(roots[0].body, /# macOS install comment/)
      assert.match(roots[0].body, /# Linux install comment/)
    })

    it('should ignore headings inside a ::: container block', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '::: code-group',
        '# heading inside container',
        '## also inside',
        ':::',
        '',
        '## Real Child',
        '',
        '> Source: /docs/real#child',
        '',
        'child body'
      ].join('\n')
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Real Heading')
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Real Child')
    })

    it('should ignore headings inside all levels of nested ::: containers', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '::: tip Title',
        '::: warning Nested',
        '# inside nested',
        ':::',
        ':::',
        '',
        '## Real Child',
        '',
        '> Source: /docs/real#child',
        '',
        'child body'
      ].join('\n')
      const roots = parse(text, config)

      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Real Child')
    })

    it('should keep a heading inside an outer container that follows a nested closed container', () => {
      const text = [
        '# Doc Title',
        'Source: /docs/x',
        '::: tip',
        '::: note',
        'inner text',
        ':::',
        '## Inside',
        'Source: /docs/x#inside',
        ':::'
      ].join('\n')

      const roots = parse(text)

      // The `## Inside` heading sits inside `::: tip`; the nested `::: note … :::`
      // must not be mistaken for the outer closer, so it stays body — not a node.
      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Doc Title')
      assert.strictEqual(roots[0].children.length, 0)
      assert.match(roots[0].body, /## Inside/)
    })

    it('should recognize a heading after nested containers close following a suppressed heading', () => {
      const text = [
        '# Doc Title',
        'Source: /docs/x',
        '::: tip',
        '::: note',
        'inner text',
        ':::',
        '## Inside',
        'Source: /docs/x#inside',
        ':::',
        '## Outside',
        'Source: /docs/x#outside',
        'outside text'
      ].join('\n')

      const roots = parse(text)

      assert.strictEqual(roots.length, 1)
      assert.match(roots[0].body, /## Inside/)
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Outside')
      assert.strictEqual(roots[0].children[0].source, '/docs/x#outside')
      assert.strictEqual(roots[0].children[0].body, 'outside text')
    })

    it('should recover at an inner closer when the outer container never closes', () => {
      const text = [
        '# Doc Title',
        'Source: /docs/x',
        '::: tip',
        '::: note',
        '## Inside',
        'Source: /docs/x#inside',
        ':::',
        '## Recovered',
        'Source: /docs/x#recovered',
        'recovered text'
      ].join('\n')

      const roots = parse(text)

      assert.strictEqual(roots.length, 1)
      assert.match(roots[0].body, /## Inside/)
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Recovered')
      assert.strictEqual(roots[0].children[0].body, 'recovered text')
    })

    it('should not shift lastHeadingIndex for a container-guarded heading so later real headings are still recognised (R04)', () => {
      const text = [
        '# Real',
        '',
        '> Source: /docs/real',
        '',
        '::: tip',
        '## Inside Container',
        ':::',
        '',
        '## After Container',
        '',
        '> Source: /docs/real#after',
        '',
        'body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'After Container')
    })

    it('should not affect the guard for a later heading when a container was opened before the previous heading (R29)', () => {
      const text = [
        '::: tip',
        'content',
        ':::',
        '',
        '# Real',
        '',
        '> Source: /docs/real',
        '',
        '## Child',
        '',
        '> Source: /docs/real#child',
        '',
        'body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Child')
    })

    it('should include a container-guarded heading in the enclosing node body (R17)', () => {
      const text = [
        '# Real',
        '',
        '> Source: /docs/real',
        '',
        '::: tip',
        '## Suppressed Heading',
        ':::',
        '',
        'after container'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].children.length, 0)
      assert.match(roots[0].body, /## Suppressed Heading/)
    })
  })

  describe('given an HTML div guard', () => {
    it('should not parse a heading inside <div class="java"> as a node', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '<div class="java">',
        '# inside java div',
        '## also inside',
        '</div>',
        '',
        '## Real Child',
        '',
        '> Source: /docs/real#child',
        '',
        'child body'
      ].join('\n')
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Real Heading')
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Real Child')
    })

    it('should not parse a heading inside <div class="cols-2"> as a node', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '<div class="cols-2">',
        '# inside cols div',
        '</div>',
        '',
        '## Real Child',
        '',
        '> Source: /docs/real#child',
        '',
        'child body'
      ].join('\n')
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Real Child')
    })

    it('should parse a heading inside an unclosed plain <div> as a node', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '<div>',
        '',
        '## Child Heading',
        '',
        '> Source: /docs/real#child',
        '',
        'child body',
        '</div>'
      ].join('\n')
      const roots = parse(text, config)

      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Child Heading')
    })

    it('should not corrupt the closer count when a closed plain <div>...</div> appears between headings', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '<div>',
        'plain content',
        '</div>',
        '',
        '<div class="java">',
        '# inside java div — must be suppressed',
        '</div>',
        '',
        '## Real Child',
        '',
        '> Source: /docs/real#child',
        '',
        'body'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'Real Child')
    })

    it('should parse a heading that comes after a closed special div', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '<div class="java">',
        'some content',
        '</div>',
        '',
        '## After Div',
        '',
        '> Source: /docs/real#after',
        '',
        'body'
      ].join('\n')
      const roots = parse(text, config)

      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'After Div')
    })

    it('should not suppress the next heading when a closed plain <div>...</div> appears between headings', () => {
      const text = [
        '# H1',
        '',
        '> Source: /docs/a',
        '',
        'first',
        '<div>irrelevant</div>',
        '## H2',
        '',
        '> Source: /docs/a#b',
        '',
        'second'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].children.length, 1)
      assert.strictEqual(roots[0].children[0].title, 'H2')
    })

    it('should suppress a heading inside a java-div that has a nested unclosed inner <div>', () => {
      const text = [
        '# Root',
        '',
        '> Source: /docs/r',
        '',
        'intro',
        '<div class="impl java">',
        '<div>',
        '## Should Not Promote',
        '',
        '> Source: /docs/r#nope',
        '',
        'inner'
      ].join('\n')
      const roots = parse(text, config)
      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].children.length, 0)
      assert.match(roots[0].body, /Should Not Promote/)
    })
  })

  describe('given edge cases and invariants', () => {
    it('should yield an empty roots array for an empty string (R01)', () => {
      assert.deepStrictEqual(parse('', config), [])
      assert.ok(Array.isArray(parse('', config)))
    })

    it('should yield an empty roots array for whitespace-only input (R01/R13)', () => {
      const result = parse('   \n\n  ', config)
      assert.ok(Array.isArray(result))
      assert.strictEqual(result.length, 0)
    })

    it('should return an empty array and emit a preamble warning to stderr for a headingless document (R12)', () => {
      const stderrChunks = []
      const orig = process.stderr.write.bind(process.stderr)
      process.stderr.write = (chunk, ...args) => {
        stderrChunks.push(String(chunk))
        return orig(chunk, ...args)
      }
      try {
        const result = parse('just text\nno headings here', config)
        assert.ok(Array.isArray(result))
        assert.strictEqual(result.length, 0)
        assert.ok(stderrChunks.some((c) => c.includes('[parse]')))
      } finally {
        process.stderr.write = orig
      }
    })

    it('should parse always returns an array regardless of input shape (R13)', () => {
      for (const input of ['', 'no headings', '# H\n\n> Source: /s\n\nbody']) {
        assert.ok(
          Array.isArray(parse(input, config)),
          `expected array for input: ${JSON.stringify(input)}`
        )
      }
    })

    it('should log a warning and drop text that appears before the first heading', () => {
      const text = 'intro line before any heading\n\n# Title\n\n> Source: /docs/title\n\nbody'
      const roots = parse(text, config)

      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0].title, 'Title')
    })

    it('should parse always collects all heading depths as tree nodes regardless of maxHeadingDepth', () => {
      const shallowConfig = { maxHeadingDepth: 2 }
      const text =
        '# A\n\n> Source: /docs/a\n\n## B\n\n> Source: /docs/a#b\n\n### C is a child node\n\n> Source: /docs/a#c\n\nmore text'
      const roots = parse(text, shallowConfig)

      assert.strictEqual(roots.length, 1)
      const b = roots[0].children[0]
      assert.strictEqual(b.title, 'B')
      assert.strictEqual(b.children.length, 1)
      const c = b.children[0]
      assert.strictEqual(c.title, 'C is a child node')
      assert.strictEqual(c.depth, 3)
      assert.match(c.body, /more text/)
    })

    it('should not emit a preamble warning for whitespace-only headingless input', () => {
      const orig = process.stderr.write.bind(process.stderr)
      let seen = ''
      process.stderr.write = (s) => {
        seen += s
        return true
      }
      try {
        parse('   \n\n  \n', config)
      } finally {
        process.stderr.write = orig
      }
      assert.doesNotMatch(seen, /preamble/)
    })
  })
})
