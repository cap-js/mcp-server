import { it, describe } from 'node:test'
import assert from 'node:assert'
import {
  parseBlocks,
  isHtmlStub,
  detectRuntime
} from '../../../lib/markdownEmbeddings/chunker/stages/04-parse-blocks.js'

describe('parseBlocks', () => {
  describe('when parsing flat blocks', () => {
    it('should parse a plain text paragraph block', () => {
      const blocks = parseBlocks('hello world')
      assert.strictEqual(blocks.length, 1)
      assert.strictEqual(blocks[0].type, 'paragraph')
      assert.ok(!('parts' in blocks[0]))
    })

    it('should parse a fenced code block', () => {
      const blocks = parseBlocks('```js\nconst x = 1\n```')
      assert.strictEqual(blocks.length, 1)
      assert.strictEqual(blocks[0].type, 'fence')
      assert.ok(!('parts' in blocks[0]))
    })

    it('should parse a paragraph followed by a fence as two blocks', () => {
      const blocks = parseBlocks('intro\n\n```js\ncode\n```')
      assert.strictEqual(blocks.length, 2)
      assert.strictEqual(blocks[0].type, 'paragraph')
      assert.strictEqual(blocks[1].type, 'fence')
    })
  })

  describe('when parsing container parts', () => {
    it('should populate parts[] for a container holding a single fence', () => {
      const body = '::: code-group\n```js\nconst x = 1\n```\n:::'
      const blocks = parseBlocks(body)
      assert.strictEqual(blocks.length, 1)
      const [container] = blocks
      assert.strictEqual(container.type, 'container')
      assert.ok(Array.isArray(container.parts), 'parts is array')
      assert.strictEqual(container.parts.length, 1)
      assert.strictEqual(container.parts[0].type, 'fence')
      assert.ok(container.parts[0].text.includes('const x = 1'))
    })

    it('should populate two parts for a container holding two fences', () => {
      const body =
        '::: code-group\n```shell [macOS]\nbrew install node\n```\n```shell [Windows]\nwinget install node\n```\n:::'
      const [container] = parseBlocks(body)
      assert.strictEqual(container.parts.length, 2)
      assert.strictEqual(container.parts[0].type, 'fence')
      assert.strictEqual(container.parts[1].type, 'fence')
      assert.ok(container.parts[0].text.includes('brew install node'))
      assert.ok(container.parts[1].text.includes('winget install node'))
    })

    it('should populate parts[] for a container holding a paragraph', () => {
      const body = '::: tip\nSome tip content.\n:::'
      const [container] = parseBlocks(body)
      assert.strictEqual(container.parts.length, 1)
      assert.strictEqual(container.parts[0].type, 'paragraph')
      assert.ok(container.parts[0].text.includes('Some tip content.'))
    })

    it('should set supressCut: true on a container so it is never split at a chunk boundary', () => {
      const body = '::: warning\nDo not use pinned versions.\n:::'
      const [container] = parseBlocks(body)
      assert.strictEqual(
        container.supressCut,
        true,
        ':::container must have supressCut:true so chunker never splits it'
      )
    })

    it('should preserve raw text in the opener and closer of a container', () => {
      const body = '::: tip\ncontent\n:::'
      const [container] = parseBlocks(body)
      assert.strictEqual(container.opener, '::: tip')
      assert.strictEqual(container.closer, ':::')
    })

    it('should give an empty container an empty parts array', () => {
      const body = '::: tip\n:::'
      const [container] = parseBlocks(body)
      assert.deepStrictEqual(container.parts, [])
    })
  })

  describe('when parsing java-div or node-div parts', () => {
    it('should populate parts[] for a java-div that holds a fence', () => {
      const body = '<div class="impl java">\n\n```sh\nmvn spring-boot:run\n```\n\n</div>'
      const [block] = parseBlocks(body)
      assert.strictEqual(block.type, 'java-div')
      assert.ok(Array.isArray(block.parts))
      assert.strictEqual(block.parts.length, 1)
      assert.strictEqual(block.parts[0].type, 'fence')
      assert.ok(block.parts[0].text.includes('mvn spring-boot:run'))
    })

    it('should populate parts[] for a node-div that holds a paragraph', () => {
      const body = '<div class="impl node">\n\nsome node content\n\n</div>'
      const [block] = parseBlocks(body)
      assert.strictEqual(block.type, 'node-div')
      assert.strictEqual(block.parts.length, 1)
      assert.strictEqual(block.parts[0].type, 'paragraph')
    })

    it('should handle three-level nesting of java-div containing a container containing a fence', () => {
      const body = [
        '<div class="impl java">',
        '',
        '::: details How to leverage Spring-MVC to use CAP mock users',
        '```java [srv/src/test/java/customer/bookshop/handlers/CatalogServiceTest.java]',
        '@RunWith(SpringRunner.class)',
        '@SpringBootTest',
        '@AutoConfigureMockMvc',
        'public class BookServiceOrdersTest {',
        '',
        '  String BOOKS_URL = "/odata/v4/CatalogService/Books";',
        '',
        '  @Autowired',
        '  private MockMvc mockMvc;',
        '',
        '  @Test',
        '  @WithMockUser(username = "viewer-user")',
        '  public void testViewer() throws Exception {',
        '    mockMvc.perform(get(BOOKS_URL)).andExpect(status().isOk());',
        '  }',
        '  @Test',
        '  public void testUnauthorized() throws Exception {',
        '    mockMvc.perform(get(BOOKS_URL)).andExpect(status().isUnauthorized());',
        '  }',
        '}',
        '```',
        ':::',
        '',
        '</div>'
      ].join('\n')

      const blocks = parseBlocks(body)
      assert.strictEqual(blocks.length, 1)

      const javaDiv = blocks[0]
      assert.strictEqual(javaDiv.type, 'java-div')
      assert.strictEqual(javaDiv.parts.length, 1)

      const container = javaDiv.parts[0]
      assert.strictEqual(container.type, 'container')
      assert.strictEqual(container.parts.length, 1)

      const fence = container.parts[0]
      assert.strictEqual(fence.type, 'fence')
      assert.ok(fence.text.includes('@RunWith(SpringRunner.class)'), 'fence content present')
      assert.ok(fence.text.includes('testViewer'), 'method present')
      assert.ok(fence.text.includes('testUnauthorized'), 'method present')
    })

    it('should produce two parts for a java-div containing a fence and a container sibling', () => {
      const body = [
        '<div class="impl java">',
        '',
        '```sh',
        'mvn spring-boot:run',
        '```',
        '',
        '::: tip',
        'CAP Java requires certain dependencies.',
        ':::',
        '',
        '</div>'
      ].join('\n')

      const [javaDiv] = parseBlocks(body)
      assert.strictEqual(javaDiv.parts.length, 2)
      assert.strictEqual(javaDiv.parts[0].type, 'fence')
      assert.strictEqual(javaDiv.parts[1].type, 'container')
      assert.strictEqual(javaDiv.parts[1].parts.length, 1)
      assert.strictEqual(javaDiv.parts[1].parts[0].type, 'paragraph')
    })
  })

  describe('when parsing cols-div parts', () => {
    it('should populate parts[] for a cols-div holding inner paragraphs', () => {
      const body =
        '<div class="cols-2">\n\n<div>\nfirst col\n</div>\n\n<div>\nsecond col\n</div>\n\n</div>'
      const [block] = parseBlocks(body)
      assert.strictEqual(block.type, 'cols-div')
      assert.ok(Array.isArray(block.parts))
      assert.ok(block.parts.length > 0)
    })

    it('should include a fence in parts for a cols-div wrapping a fence', () => {
      const body = '<div class="cols-2">\n\n```js\nconst a = 1;\n```\n\n</div>'
      const [block] = parseBlocks(body)
      assert.strictEqual(block.type, 'cols-div')
      assert.strictEqual(block.parts.length, 1)
      assert.strictEqual(block.parts[0].type, 'fence')
      assert.ok(block.parts[0].text.includes('const a = 1;'))
    })
  })

  describe('when parsing redirect blocks', () => {
    it('should parse a link with {.learn-more} as a redirect block', () => {
      const blocks = parseBlocks('[Learn more.](../foo/bar){.learn-more}')
      assert.strictEqual(blocks.length, 1)
      assert.strictEqual(blocks[0].type, 'redirect')
      assert.strictEqual(blocks[0].supressCut, true)
      assert.ok(Array.isArray(blocks[0].parts))
    })

    it('should parse a link with { .learn-more} (space before dot) as a redirect block', () => {
      const [block] = parseBlocks('[Learn more about _CDS_.](../cds/){ .learn-more}')
      assert.strictEqual(block.type, 'redirect')
    })

    it('should parse plain text ending with {.learn-more} as a redirect block', () => {
      const [block] = parseBlocks(
        'Refer to *On the Nature of Models* in the CDS reference docs. {.learn-more}'
      )
      assert.strictEqual(block.type, 'redirect')
    })

    it('should not absorb a following paragraph into a redirect block', () => {
      const body = '[Learn more.](../foo){.learn-more}\n\nSome following prose.'
      const blocks = parseBlocks(body)
      assert.strictEqual(blocks.length, 2)
      assert.strictEqual(blocks[0].type, 'redirect')
      assert.strictEqual(blocks[1].type, 'paragraph')
    })

    it('should not absorb a following redirect into a paragraph block', () => {
      const body = 'Some prose.\n\n[Learn more.](../foo){.learn-more}'
      const blocks = parseBlocks(body)
      assert.strictEqual(blocks.length, 2)
      assert.strictEqual(blocks[0].type, 'paragraph')
      assert.strictEqual(blocks[1].type, 'redirect')
    })

    it('should keep a plain paragraph without {.learn-more} as a paragraph block', () => {
      const [block] = parseBlocks('Some prose without a redirect class.')
      assert.strictEqual(block.type, 'paragraph')
    })
  })

  describe('when detecting the isLeadIn paragraph flag', () => {
    const para = (text) => parseBlocks(text).find((b) => b.type === 'paragraph')

    it('should set isLeadIn for a paragraph ending with a trailing colon', () => {
      assert.strictEqual(para('Use this command:').isLeadIn, true)
    })

    it('should set isLeadIn for "as follows:"', () => {
      assert.strictEqual(para('Configure it as follows:').isLeadIn, true)
    })

    it('should set isLeadIn for "the following" at the end', () => {
      assert.strictEqual(para('Consider the following').isLeadIn, true)
    })

    it('should set isLeadIn for "the following" mid-sentence', () => {
      assert.strictEqual(
        para(
          'The following snippet demonstrates which ui annotations you need to expose your extensions to the SAP Fiori Elements UI.'
        ).isLeadIn,
        true
      )
    })

    it('should set isLeadIn for "shown below"', () => {
      assert.strictEqual(para('An example is shown below.').isLeadIn, true)
    })

    it('should not set isLeadIn when ::: appears as the container closer', () => {
      assert.strictEqual(para('Some content.\n\n:::')?.isLeadIn ?? false, false)
    })

    it('should not set isLeadIn for a plain sentence without a lead-in phrase', () => {
      assert.strictEqual(para('This is a regular sentence.').isLeadIn, false)
    })
  })

  describe('when detecting the isAnaphoric paragraph flag', () => {
    const para = (text) => parseBlocks(text).find((b) => b.type === 'paragraph')

    it('should set isAnaphoric for "These "', () => {
      assert.strictEqual(para('These items are important.').isAnaphoric, true)
    })

    it('should set isAnaphoric for "They "', () => {
      assert.strictEqual(para('They are defined here.').isAnaphoric, true)
    })

    it('should set isAnaphoric for "Those "', () => {
      assert.strictEqual(para('Those values control X.').isAnaphoric, true)
    })

    it('should not set isAnaphoric for "This " (not in current word list)', () => {
      assert.strictEqual(para('This option enables the feature.').isAnaphoric, false)
    })

    it('should not set isAnaphoric for "Note that " (not in current word list)', () => {
      assert.strictEqual(para('Note that this only applies to Java.').isAnaphoric, false)
    })

    it('should not set isAnaphoric for a plain sentence', () => {
      assert.strictEqual(para('A regular sentence.').isAnaphoric, false)
    })

    it('should set isAnaphoric even when leading blank lines precede the first word', () => {
      assert.strictEqual(para('\n\nThese start after blanks.').isAnaphoric, true)
    })
  })

  describe('when parsing admonition blocks', () => {
    it('should tokenize a GFM admonition containing a > ::: code-group fence as a single admonition block', () => {
      const body = [
        '> [!danger] Never undeploy hdbtable files',
        '> Never have entries for _tables_ in _undeploy.json_.',
        '> ::: code-group',
        '> ```json [db/undeploy.json]',
        '>   "src/...hdbtable" // data loss',
        '> ```',
        '> :::'
      ].join('\n')
      const blocks = parseBlocks(body)
      assert.strictEqual(
        blocks.length,
        1,
        'admonition must be a single block, not split by inner > :::'
      )
      assert.strictEqual(blocks[0].type, 'admonition')
    })

    it('should mark a GFM admonition as splittable (not atomic)', () => {
      const body = '> [!warning]\n> Do not use pinned versions.'
      const [block] = parseBlocks(body)
      assert.strictEqual(block.type, 'admonition')
      assert.strictEqual(block.atomic, undefined)
    })

    it('should recognise a blockquote-prefixed fence inside an admonition as a fence part, not a paragraph', () => {
      const body = [
        '> [!danger] Never undeploy hdbtable files',
        '> Never have entries for _tables_ in _undeploy.json_.',
        '> ::: code-group',
        '> ```json [db/undeploy.json]',
        '>   "src/...hdbtable" // data loss',
        '> ```',
        '> :::'
      ].join('\n')
      const blocks = parseBlocks(body)
      assert.strictEqual(blocks[0].type, 'admonition')
      const innerContainer = blocks[0].parts?.find((p) => p.type === 'container')
      assert.ok(innerContainer, 'inner ::: code-group must be parsed as a container part')
      const fencePart = innerContainer?.parts?.find((p) => p.type === 'fence')
      assert.ok(
        fencePart,
        `inner fence must be a fence block, not paragraph. parts: ${JSON.stringify(innerContainer?.parts?.map((p) => p.type))}`
      )
    })
  })

  describe('when parsing list blocks', () => {
    it('should parse a numbered list with 3 items and a nested bullet list as one block', () => {
      const body = [
        "1. If `paths` is `'*'`: `paths` = [ ...`cds.env.roots`, ...`cds.requires.<srv>.model` ]",
        '2. If `paths` is a single string: `paths` = [ `paths` ]',
        '3. For `<each>` in `paths`: ...',
        '- if _\\<each>.csn|cds_ exists &rarr; use it',
        '- if _\\<each>/index.csn|cds_ exists &rarr; use it',
        '- if _\\<each>_ is a folder &rarr; use all _.csn|cds_ found in there'
      ].join('\n')
      const blocks = parseBlocks(body)
      assert.strictEqual(blocks.length, 1)
      assert.strictEqual(blocks[0].type, 'list')
      assert.strictEqual(blocks[0].parts.length, 3)
      assert.ok(blocks[0].parts.every((b) => b.type === 'list-item'))
      assert.strictEqual(blocks[0].parts[2].parts.length, 1)
      assert.strictEqual(blocks[0].parts[2].parts[0].type, 'list')
      assert.strictEqual(blocks[0].parts[2].parts[0].parts.length, 3)
      assert.ok(blocks[0].parts[2].parts[0].parts.every((p) => p.type === 'bullet-item'))
    })

    it('should parse a single numbered item that contains one nested bullet-list block', () => {
      const body = [
        '1. Removed deprecated properties:',
        '- eventContext: Interfaces for actions and functions now always extend `EventContext`.',
        '- cqnService: Typed interfaces are now always generated for the application service.'
      ].join('\n')
      const blocks = parseBlocks(body)
      assert.strictEqual(blocks.length, 1)
      assert.strictEqual(blocks[0].type, 'list')
      assert.strictEqual(blocks[0].parts.length, 1)
      assert.strictEqual(blocks[0].parts[0].type, 'list-item')
      assert.strictEqual(blocks[0].parts[0].opener, '1. Removed deprecated properties:')
      assert.strictEqual(blocks[0].parts[0].parts.length, 1)
      assert.strictEqual(blocks[0].parts[0].parts[0].type, 'list')
      assert.strictEqual(blocks[0].parts[0].parts[0].parts.length, 2)
    })
  })

  describe('when filling flowchart gaps', () => {
    it('should close a fence on a longer delimiter than the opening one', () => {
      const body = '```js\nconst x = 1\n`````'
      const blocks = parseBlocks(body)
      assert.strictEqual(blocks.length, 1)
      assert.strictEqual(blocks[0].type, 'fence')
      assert.ok(blocks[0].text.endsWith('`````'))
    })

    it('should not close a fence on a backtick run with trailing text', () => {
      const body = [
        '```cds [CDS Source]',
        'entity Source { ..., value: String }',
        'entity Projection as select from Source { ... };',
        '',
        "annotate Source:value with @sql.append: 'FUZZY SEARCH INDEX ON';",
        'annotate Source with @sql.append: ```sql',
        '  GROUP TYPE foo',
        '  GROUP SUBTYPE bar',
        '```;',
        '',
        "annotate Projection with @sql.append: 'WITH DDL ONLY';",
        '',
        '```',
        '```sql [=> &nbsp; Generated DDL]',
        'CREATE TABLE Source ( ...,',
        '  value NVARCHAR(100) FUZZY SEARCH INDEX ON',
        ') GROUP TYPE foo',
        'GROUP SUBTYPE bar;',
        'CREATE VIEW Projection AS SELECT ... FROM Source WITH DDL ONLY;',
        '```'
      ].join('\n')

      const blocks = parseBlocks(body)

      assert.strictEqual(blocks.length, 2)
      assert.strictEqual(blocks[0].type, 'fence')
      assert.strictEqual(blocks[1].type, 'fence')
      assert.ok(blocks[0].text.includes('```;'))
      assert.ok(blocks[0].text.includes('WITH DDL ONLY'))
      assert.ok(blocks[1].text.includes('CREATE VIEW'))
    })

    it('should leave opener and closer undefined for a ::: code-group container', () => {
      const body = '::: code-group\n```js\ncode\n```\n:::'
      const [block] = parseBlocks(body)
      assert.strictEqual(block.type, 'container')
      assert.strictEqual(block.opener, undefined)
      assert.strictEqual(block.closer, undefined)
    })

    it('should still tokenize inner content of an unclosed ::: container at EOF', () => {
      const body = '::: tip\nhello inner content'
      const [block] = parseBlocks(body)
      assert.strictEqual(block.type, 'container')
      assert.ok(block.parts.length >= 1)
      assert.strictEqual(block.parts[0].type, 'paragraph')
      assert.ok(block.parts[0].text.includes('hello inner content'))
    })

    it('should throw a no-closer error for a java-div with no closing </div>', () => {
      const body = '<div class="impl java">\nsome content without closer'
      assert.throws(() => parseBlocks(body), /no closer for/)
    })

    it('should throw a no-parts error for an empty java-div', () => {
      const body = '<div class="impl java">\n</div>'
      assert.throws(() => parseBlocks(body), /no parts for/)
    })

    it('should throw a no-parts error for an empty cols-2 div', () => {
      const body = '<div class="cols-2">\n</div>'
      assert.throws(() => parseBlocks(body), /no parts for/)
    })

    it('should capture a nested <table> inside an outer <table> as a single html-table block', () => {
      const body = [
        '<table>',
        '<tr><td>',
        '<table><tr><td>inner</td></tr></table>',
        '</td></tr>',
        '</table>'
      ].join('\n')
      const blocks = parseBlocks(body)
      assert.strictEqual(blocks.length, 1)
      assert.strictEqual(blocks[0].type, 'html-table')
      assert.ok(blocks[0].text.includes('inner'))
      assert.strictEqual((blocks[0].text.match(/<\/table>/g) || []).length, 2)
    })

    it('should absorb an indented continuation across a blank line into a numbered list item', () => {
      const body = ['1. first item', '', '   continuation of item 1', '', '2. second item'].join(
        '\n'
      )
      const [list] = parseBlocks(body)
      assert.strictEqual(list.type, 'list')
      const items = list.parts
      assert.strictEqual(items.length, 2)
      const firstInner = items[0].parts?.map((p) => p.text).join(' ') ?? ''
      assert.ok(
        firstInner.includes('continuation of item 1'),
        `item 1 must absorb its indented continuation; got parts=${JSON.stringify(items[0].parts?.map((p) => p.type))}`
      )
    })

    it('should treat -/* markers at the same indent as same-level bullet items', () => {
      const body = '- alpha\n* beta'
      const [list] = parseBlocks(body)
      assert.strictEqual(list.type, 'list')
      const items = list.parts
      assert.strictEqual(items.length, 2)
      assert.ok(items[0].text.includes('alpha'))
      assert.ok(items[1].text.includes('beta'))
    })

    it('should use a text fallback for a bare > [!TIP] admonition line with no follow-up', () => {
      const body = '> [!TIP] short note'
      const [block] = parseBlocks(body)
      assert.strictEqual(block.type, 'admonition')
      assert.strictEqual(block.opener, undefined)
      assert.ok(block.text?.includes('[!TIP]'))
    })

    it('should produce a heading block from a heading with a valid Source line in the body', () => {
      const body = [
        'intro paragraph',
        '',
        '#### Nested Heading',
        '',
        '> Source: /docs/a#nested',
        '',
        'after heading'
      ].join('\n')
      const blocks = parseBlocks(body)
      const headingBlock = blocks.find((b) => b.type === 'heading')
      assert.ok(headingBlock, 'heading block must be emitted')
      assert.strictEqual(headingBlock.isLeadIn, true)
      assert.strictEqual(headingBlock.supressCut, false)
      const sourceAsPara = blocks.find(
        (b) => b.type === 'paragraph' && b.text.startsWith('> Source:')
      )
      assert.strictEqual(sourceAsPara, undefined, 'Source line must be consumed with heading')
    })
  })

  describe('when detecting runtime', () => {
    describe('given the detectRuntime helper', () => {
      it("should return 'java' when only Java is detected", () =>
        assert.strictEqual(detectRuntime('Use the Java SDK.'), 'java'))
      it("should return 'node' when only Node.js is detected", () =>
        assert.strictEqual(detectRuntime('Use Node.js for this.'), 'node'))
      it('should return null when both Java and Node.js are detected', () =>
        assert.strictEqual(detectRuntime('Java and Node.js both work.'), null))
      it('should return null when neither Java nor Node.js is detected', () =>
        assert.strictEqual(detectRuntime('Plain text.'), null))
      it('should not match Java for input that contains only JavaScript', () =>
        assert.strictEqual(detectRuntime('Use JavaScript here.'), null))
      it('should return null for null or empty input', () =>
        assert.strictEqual(detectRuntime(null), null))
    })

    describe('when a fence has a [Node.js] or [Java] bracket label', () => {
      it('should set runtime: node for a fence with a [Node.js] bracket label', () => {
        const [b] = parseBlocks('```sh [Node.js]\nnpm install\n```')
        assert.strictEqual(b.type, 'fence')
        assert.strictEqual(b.runtime, 'node')
      })

      it('should set runtime: java for a fence with a [Java] bracket label', () => {
        const [b] = parseBlocks('```sh [Java]\nmvn install\n```')
        assert.strictEqual(b.type, 'fence')
        assert.strictEqual(b.runtime, 'java')
      })

      it('should not set runtime for a fence without a bracket label', () => {
        const [b] = parseBlocks('```js\nconst x = 1\n```')
        assert.strictEqual(b.runtime, undefined)
      })
    })

    describe('when reading the runtime field of a java-div or node-div', () => {
      it('should set runtime: java for a java-div block', () => {
        const [b] = parseBlocks('<div class="impl java">\n\nsome content\n\n</div>')
        assert.strictEqual(b.type, 'java-div')
        assert.strictEqual(b.runtime, 'java')
      })

      it('should set runtime: node for a node-div block', () => {
        const [b] = parseBlocks('<div class="impl node">\n\nsome content\n\n</div>')
        assert.strictEqual(b.type, 'node-div')
        assert.strictEqual(b.runtime, 'node')
      })
    })

    describe('when reading runtime from a container opener', () => {
      it('should set runtime: java for a container opener mentioning only Java', () => {
        const [b] = parseBlocks('::: tip Only Java\nsome content\n:::')
        assert.strictEqual(b.type, 'container')
        assert.strictEqual(b.runtime, 'java')
      })

      it('should set runtime: node for a container opener mentioning Node.js users', () => {
        const [b] = parseBlocks('::: tip For Node.js users\nsome content\n:::')
        assert.strictEqual(b.type, 'container')
        assert.strictEqual(b.runtime, 'node')
      })

      it('should not set runtime for a container opener mentioning both Java and Node.js', () => {
        const [b] = parseBlocks('::: tip Java and Node.js\nsome content\n:::')
        assert.strictEqual(b.runtime, undefined)
      })

      it('should not set runtime for a ::: code-group that has no opener', () => {
        const [b] = parseBlocks('::: code-group\n```js\ncode\n```\n:::')
        assert.strictEqual(b.runtime, undefined)
      })
    })

    describe('when reading runtime from an admonition opener', () => {
      it('should set runtime: node for an admonition opener mentioning Node.js only', () => {
        const [b] = parseBlocks('> [!note] Node.js only\n> some content')
        assert.strictEqual(b.type, 'admonition')
        assert.strictEqual(b.runtime, 'node')
      })

      it('should set runtime: java for an admonition opener mentioning Java', () => {
        const [b] = parseBlocks('> [!tip] Java setup\n> some content')
        assert.strictEqual(b.type, 'admonition')
        assert.strictEqual(b.runtime, 'java')
      })

      it('should not set runtime for an admonition opener mentioning both Java and Node.js', () => {
        const [b] = parseBlocks('> [!warning] Java and Node.js\n> some content')
        assert.strictEqual(b.runtime, undefined)
      })
    })

    describe('when reading runtime from a heading', () => {
      function headingBlock(body) {
        return parseBlocks(body).find((b) => b.type === 'heading')
      }

      it("should set runtime: java for a heading reading 'Java and Maven'", () => {
        const body = 'intro\n\n## Java and Maven\n\n> Source: /docs/a#java-and-maven\n\nbody'
        const h = headingBlock(body)
        assert.ok(h, 'heading block must be emitted')
        assert.strictEqual(h.runtime, 'java')
      })

      it("should set runtime: node for a heading reading 'Node.js and cds-dk'", () => {
        const body = 'intro\n\n## Node.js and cds-dk\n\n> Source: /docs/a#nodejs-and-cds-dk\n\nbody'
        const h = headingBlock(body)
        assert.ok(h, 'heading block must be emitted')
        assert.strictEqual(h.runtime, 'node')
      })

      it('should not set runtime for a heading containing both Java and Node.js', () => {
        const body = 'intro\n\n## Java and Node.js\n\n> Source: /docs/a#java-and-nodejs\n\nbody'
        const h = headingBlock(body)
        assert.ok(h, 'heading block must be emitted')
        assert.strictEqual(h.runtime, undefined)
      })

      it('should not set runtime for a heading with no runtime keyword', () => {
        const body = 'intro\n\n## General Guide\n\n> Source: /docs/a#general-guide\n\nbody'
        const h = headingBlock(body)
        assert.ok(h, 'heading block must be emitted')
        assert.strictEqual(h.runtime, undefined)
      })
    })

    describe('when reading runtime from a paragraph', () => {
      it('should not set runtime for prose containing both Java and Node.js', () => {
        const [b] = parseBlocks('Both Java and Node.js are supported.')
        assert.strictEqual(b.runtime, undefined)
      })

      it('should not set runtime for prose containing only JavaScript', () => {
        const [b] = parseBlocks('Use JavaScript for this.')
        assert.strictEqual(b.runtime, undefined)
      })

      it('should not set runtime for prose containing neither Java nor Node.js', () => {
        const [b] = parseBlocks('This is a generic paragraph.')
        assert.strictEqual(b.runtime, undefined)
      })
    })
  })

  describe('when detecting raw HTML stubs (isHtmlStub)', () => {
    it('should detect <br/> standalone as a stub', () => {
      assert.strictEqual(isHtmlStub('<br/>'), true)
    })

    it('should identify <br> standalone as a stub', () => {
      assert.strictEqual(isHtmlStub('<br>'), true)
    })

    it('should identify <img src="x.png"/> standalone as a stub', () => {
      assert.strictEqual(isHtmlStub('<img src="x.png"/>'), true)
    })

    it('should identify <div id="foo" /> standalone as a stub', () => {
      assert.strictEqual(isHtmlStub('<div id="foo" />'), true)
    })

    it('should identify <span id="afterAddingData" /> standalone as a stub', () => {
      assert.strictEqual(isHtmlStub('<span id="afterAddingData" />'), true)
    })

    it('should not identify plain paragraph text as a stub', () => {
      assert.strictEqual(isHtmlStub('Some regular prose here.'), false)
    })

    it('should not identify a markdown link line as a stub', () => {
      assert.strictEqual(isHtmlStub('[Learn more](https://cap.cloud.sap)'), false)
    })

    it('should not identify a non-empty paired tag as a stub', () => {
      assert.strictEqual(isHtmlStub('<div>content</div>'), false)
    })
  })
})
