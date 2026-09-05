import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, isHtmlStub } from '../../stages/04-parse-blocks.js';

describe('parseBlocks', () => {
  describe('flat blocks', () => {
    test('paragraph', () => {
      const blocks = parseBlocks('hello world');
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].type, 'paragraph');
      assert.ok(!('parts' in blocks[0]));
    });

    test('fence', () => {
      const blocks = parseBlocks('```js\nconst x = 1\n```');
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].type, 'fence');
      assert.ok(!('parts' in blocks[0]));
    });

    test('paragraph then fence', () => {
      const blocks = parseBlocks('intro\n\n```js\ncode\n```');
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0].type, 'paragraph');
      assert.equal(blocks[1].type, 'fence');
    });
  });

  describe('container parts', () => {
    test('container with single fence gets parts[]', () => {
      const body = '::: code-group\n```js\nconst x = 1\n```\n:::';
      const blocks = parseBlocks(body);
      assert.equal(blocks.length, 1);
      const [container] = blocks;
      assert.equal(container.type, 'container');
      assert.ok(Array.isArray(container.parts), 'parts is array');
      assert.equal(container.parts.length, 1);
      assert.equal(container.parts[0].type, 'fence');
      assert.ok(container.parts[0].text.includes('const x = 1'));
    });

    test('container with two fences gets two parts', () => {
      const body = '::: code-group\n```shell [macOS]\nbrew install node\n```\n```shell [Windows]\nwinget install node\n```\n:::';
      const [container] = parseBlocks(body);
      assert.equal(container.parts.length, 2);
      assert.equal(container.parts[0].type, 'fence');
      assert.equal(container.parts[1].type, 'fence');
      assert.ok(container.parts[0].text.includes('brew install node'));
      assert.ok(container.parts[1].text.includes('winget install node'));
    });

    test('container with paragraph part', () => {
      const body = '::: tip\nSome tip content.\n:::';
      const [container] = parseBlocks(body);
      assert.equal(container.parts.length, 1);
      assert.equal(container.parts[0].type, 'paragraph');
      assert.ok(container.parts[0].text.includes('Some tip content.'));
    });

    test('container has supressCut: true — treated as atomic unit, never split at chunk boundary', () => {
      const body = '::: warning\nDo not use pinned versions.\n:::';
      const [container] = parseBlocks(body);
      assert.equal(container.supressCut, true, ':::container must have supressCut:true so chunker never splits it');
    });

    test('container raw text preserved in opener/closer', () => {
      const body = '::: tip\ncontent\n:::';
      const [container] = parseBlocks(body);
      assert.equal(container.opener, '::: tip');
      assert.equal(container.closer, ':::');
    });

    test('empty container has empty parts array', () => {
      const body = '::: tip\n:::';
      const [container] = parseBlocks(body);
      assert.deepEqual(container.parts, []);
    });
  });

  describe('java-div / node-div parts', () => {
    test('java-div with fence gets parts[]', () => {
      const body = '<div class="impl java">\n\n```sh\nmvn spring-boot:run\n```\n\n</div>';
      const [block] = parseBlocks(body);
      assert.equal(block.type, 'java-div');
      assert.ok(Array.isArray(block.parts));
      assert.equal(block.parts.length, 1);
      assert.equal(block.parts[0].type, 'fence');
      assert.ok(block.parts[0].text.includes('mvn spring-boot:run'));
    });

    test('node-div with paragraph gets parts[]', () => {
      const body = '<div class="impl node">\n\nsome node content\n\n</div>';
      const [block] = parseBlocks(body);
      assert.equal(block.type, 'node-div');
      assert.equal(block.parts.length, 1);
      assert.equal(block.parts[0].type, 'paragraph');
    });

    test('java-div → container(::: details) → fence: three-level nesting', () => {
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
        '</div>',
      ].join('\n');

      const blocks = parseBlocks(body);
      assert.equal(blocks.length, 1);

      const javaDiv = blocks[0];
      assert.equal(javaDiv.type, 'java-div');
      assert.equal(javaDiv.parts.length, 1);

      const container = javaDiv.parts[0];
      assert.equal(container.type, 'container');
      assert.equal(container.parts.length, 1);

      const fence = container.parts[0];
      assert.equal(fence.type, 'fence');
      assert.ok(fence.text.includes('@RunWith(SpringRunner.class)'), 'fence content present');
      assert.ok(fence.text.includes('testViewer'), 'method present');
      assert.ok(fence.text.includes('testUnauthorized'), 'method present');
    });

    test('java-div with fence and container sibling: two parts', () => {
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
        '</div>',
      ].join('\n');

      const [javaDiv] = parseBlocks(body);
      assert.equal(javaDiv.parts.length, 2);
      assert.equal(javaDiv.parts[0].type, 'fence');
      assert.equal(javaDiv.parts[1].type, 'container');
      assert.equal(javaDiv.parts[1].parts.length, 1);
      assert.equal(javaDiv.parts[1].parts[0].type, 'paragraph');
    });
  });

  describe('cols-div parts', () => {
    test('cols-div with inner paragraphs gets parts[]', () => {
      const body = '<div class="cols-2">\n\n<div>\nfirst col\n</div>\n\n<div>\nsecond col\n</div>\n\n</div>';
      const [block] = parseBlocks(body);
      assert.equal(block.type, 'cols-div');
      assert.ok(Array.isArray(block.parts));
      assert.ok(block.parts.length > 0);
    });

    test('cols-div with fence inside: fence in parts', () => {
      const body = '<div class="cols-2">\n\n```js\nconst a = 1;\n```\n\n</div>';
      const [block] = parseBlocks(body);
      assert.equal(block.type, 'cols-div');
      assert.equal(block.parts.length, 1);
      assert.equal(block.parts[0].type, 'fence');
      assert.ok(block.parts[0].text.includes('const a = 1;'));
    });
  });

  describe('redirect blocks', () => {
    test('link form {.learn-more}', () => {
      const blocks = parseBlocks('[Learn more.](../foo/bar){.learn-more}');
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].type, 'redirect');
      assert.equal(blocks[0].supressCut, true);
      assert.ok(Array.isArray(blocks[0].parts));
    });

    test('link form with space { .learn-more}', () => {
      const [block] = parseBlocks('[Learn more about _CDS_.](../cds/){ .learn-more}');
      assert.equal(block.type, 'redirect');
    });

    test('plain text form', () => {
      const [block] = parseBlocks('Refer to *On the Nature of Models* in the CDS reference docs. {.learn-more}');
      assert.equal(block.type, 'redirect');
    });

    test('redirect does not absorb following paragraph', () => {
      const body = '[Learn more.](../foo){.learn-more}\n\nSome following prose.';
      const blocks = parseBlocks(body);
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0].type, 'redirect');
      assert.equal(blocks[1].type, 'paragraph');
    });

    test('paragraph does not absorb following redirect', () => {
      const body = 'Some prose.\n\n[Learn more.](../foo){.learn-more}';
      const blocks = parseBlocks(body);
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0].type, 'paragraph');
      assert.equal(blocks[1].type, 'redirect');
    });

    test('plain paragraph without {.learn-more} stays paragraph', () => {
      const [block] = parseBlocks('Some prose without a redirect class.');
      assert.equal(block.type, 'paragraph');
    });
  });

  describe('paragraph isLeadIn flag', () => {
    const para = (text) => parseBlocks(text).find(b => b.type === 'paragraph');

    test('trailing colon sets isLeadIn', () => {
      assert.equal(para('Use this command:').isLeadIn, true);
    });

    test('"as follows:" sets isLeadIn', () => {
      assert.equal(para('Configure it as follows:').isLeadIn, true);
    });

    test('"the following" at end sets isLeadIn', () => {
      assert.equal(para('Consider the following').isLeadIn, true);
    });

    test('"the following" mid-sentence sets isLeadIn', () => {
      assert.equal(para('The following snippet demonstrates which ui annotations you need to expose your extensions to the SAP Fiori Elements UI.').isLeadIn, true);
    });

    test('"shown below" sets isLeadIn', () => {
      assert.equal(para('An example is shown below.').isLeadIn, true);
    });

    test('container closer ::: as last line does NOT set isLeadIn', () => {
      assert.equal(para('Some content.\n\n:::')?.isLeadIn ?? false, false);
    });

    test('plain sentence without lead-in phrase is NOT isLeadIn', () => {
      assert.equal(para('This is a regular sentence.').isLeadIn, false);
    });
  });

  describe('paragraph isAnaphoric flag', () => {
    const para = (text) => parseBlocks(text).find(b => b.type === 'paragraph');

    test('"These " sets isAnaphoric', () => {
      assert.equal(para('These items are important.').isAnaphoric, true);
    });

    test('"They " sets isAnaphoric', () => {
      assert.equal(para('They are defined here.').isAnaphoric, true);
    });

    test('"Those " sets isAnaphoric', () => {
      assert.equal(para('Those values control X.').isAnaphoric, true);
    });

    test('"This " does NOT set isAnaphoric (not in current word list)', () => {
      assert.equal(para('This option enables the feature.').isAnaphoric, false);
    });

    test('"Note that " does NOT set isAnaphoric (not in current word list)', () => {
      assert.equal(para('Note that this only applies to Java.').isAnaphoric, false);
    });

    test('plain sentence is NOT isAnaphoric', () => {
      assert.equal(para('A regular sentence.').isAnaphoric, false);
    });

    test('leading blanks ignored when checking first line', () => {
      assert.equal(para('\n\nThese start after blanks.').isAnaphoric, true);
    });
  });

  describe('admonition blocks', () => {
    test('GFM admonition with > ::: code-group inner fence — tokenized as single admonition block', () => {
      const body = [
        '> [!danger] Never undeploy hdbtable files',
        '> Never have entries for _tables_ in _undeploy.json_.',
        '> ::: code-group',
        '> ```json [db/undeploy.json]',
        '>   "src/...hdbtable" // data loss',
        '> ```',
        '> :::',
      ].join('\n');
      const blocks = parseBlocks(body);
      assert.equal(blocks.length, 1, 'admonition must be a single block, not split by inner > :::');
      assert.equal(blocks[0].type, 'admonition');
    });

    test('GFM admonition has supressCut: true — treated as atomic unit', () => {
      const body = '> [!warning]\n> Do not use pinned versions.';
      const [block] = parseBlocks(body);
      assert.equal(block.type, 'admonition');
      assert.equal(block.supressCut, true, 'GFM admonition must have supressCut:true so chunker never splits it');
    });

    test('blockquote-prefixed fence inside admonition is recognised as a fence part (not paragraph)', () => {
      const body = [
        '> [!danger] Never undeploy hdbtable files',
        '> Never have entries for _tables_ in _undeploy.json_.',
        '> ::: code-group',
        '> ```json [db/undeploy.json]',
        '>   "src/...hdbtable" // data loss',
        '> ```',
        '> :::',
      ].join('\n');
      const blocks = parseBlocks(body);
      assert.equal(blocks[0].type, 'admonition');
      const innerContainer = blocks[0].parts?.find(p => p.type === 'container');
      assert.ok(innerContainer, 'inner ::: code-group must be parsed as a container part');
      const fencePart = innerContainer?.parts?.find(p => p.type === 'fence');
      assert.ok(
        fencePart,
        `inner fence must be a fence block, not paragraph. parts: ${JSON.stringify(innerContainer?.parts?.map(p => p.type))}`
      );
    });
  });

  describe('list blocks', () => {
    test('numbered list followed immediately by bullet items: 3 list-items, last has 3 bullet-item parts', () => {
      const body = [
        '1. If `paths` is `\'*\'`: `paths` = [ ...`cds.env.roots`, ...`cds.requires.<srv>.model` ]',
        '2. If `paths` is a single string: `paths` = [ `paths` ]',
        '3. For `<each>` in `paths`: ...',
        '- if _\\<each>.csn|cds_ exists &rarr; use it',
        '- if _\\<each>/index.csn|cds_ exists &rarr; use it',
        '- if _\\<each>_ is a folder &rarr; use all _.csn|cds_ found in there',
      ].join('\n');
      const blocks = parseBlocks(body);
      assert.equal(blocks.length, 3);
      assert.ok(blocks.every(b => b.type === 'list-item'));
      assert.equal(blocks[2].parts.length, 3);
      assert.ok(blocks[2].parts.every(p => p.type === 'bullet-item'));
    });

    test('single numbered item followed immediately by bullet items: 1 list-item with 2 bullet-item parts', () => {
      const body = [
        '1. Removed deprecated properties:',
        '- eventContext: Interfaces for actions and functions now always extend `EventContext`.',
        '- cqnService: Typed interfaces are now always generated for the application service.',
      ].join('\n');
      const blocks = parseBlocks(body);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].type, 'list-item');
      assert.equal(blocks[0].opener, '1. Removed deprecated properties:');
      assert.equal(blocks[0].parts.length, 2);
      assert.ok(blocks[0].parts.every(p => p.type === 'bullet-item'));
    });
  });

  describe('flowchart gap-fills', () => {
    test('fence opened with ``` closes on ````` (longer delimiter)', () => {
      const body = '```js\nconst x = 1\n`````';
      const blocks = parseBlocks(body);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].type, 'fence');
      assert.ok(blocks[0].text.endsWith('`````'));
    });

    test('::: code-group container leaves opener and closer undefined', () => {
      const body = '::: code-group\n```js\ncode\n```\n:::';
      const [block] = parseBlocks(body);
      assert.equal(block.type, 'container');
      assert.equal(block.opener, undefined);
      assert.equal(block.closer, undefined);
    });

    test('unclosed ::: container at EOF still tokenizes inner content', () => {
      const body = '::: tip\nhello inner content';
      const [block] = parseBlocks(body);
      assert.equal(block.type, 'container');
      assert.ok(block.parts.length >= 1);
      assert.equal(block.parts[0].type, 'paragraph');
      assert.ok(block.parts[0].text.includes('hello inner content'));
    });

    test('java-div with no </div> throws no-closer error', () => {
      const body = '<div class="impl java">\nsome content without closer';
      assert.throws(() => parseBlocks(body), /no closer for/);
    });

    test('empty java-div throws no-parts error', () => {
      const body = '<div class="impl java">\n</div>';
      assert.throws(() => parseBlocks(body), /no parts for/);
    });

    test('empty cols-2 div throws no-parts error', () => {
      const body = '<div class="cols-2">\n</div>';
      assert.throws(() => parseBlocks(body), /no parts for/);
    });

    test('nested <table> inside outer <table> is captured as single html-table block', () => {
      const body = [
        '<table>',
        '<tr><td>',
        '<table><tr><td>inner</td></tr></table>',
        '</td></tr>',
        '</table>',
      ].join('\n');
      const blocks = parseBlocks(body);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].type, 'html-table');
      assert.ok(blocks[0].text.includes('inner'));
      assert.equal((blocks[0].text.match(/<\/table>/g) || []).length, 2);
    });

    test('numbered list item absorbs indented continuation across blank line', () => {
      const body = [
        '1. first item',
        '',
        '   continuation of item 1',
        '',
        '2. second item',
      ].join('\n');
      const items = parseBlocks(body).filter(b => b.type === 'list-item');
      assert.equal(items.length, 2);
      const firstInner = items[0].parts?.map(p => p.text).join(' ') ?? '';
      assert.ok(
        firstInner.includes('continuation of item 1'),
        `item 1 must absorb its indented continuation; got parts=${JSON.stringify(items[0].parts?.map(p => p.type))}`
      );
    });

    test('bullet list treats -/* markers at same indent as same-level items', () => {
      const body = '- alpha\n* beta';
      const items = parseBlocks(body).filter(b => b.type === 'bullet-item');
      assert.equal(items.length, 2);
      assert.ok(items[0].text.includes('alpha'));
      assert.ok(items[1].text.includes('beta'));
    });

    test('bare > [!TIP] admonition line with no follow-up uses text fallback', () => {
      const body = '> [!TIP] short note';
      const [block] = parseBlocks(body);
      assert.equal(block.type, 'admonition');
      assert.equal(block.opener, undefined);
      assert.ok(block.text?.includes('[!TIP]'));
    });

    test('heading with valid Source line inside body produces heading block', () => {
      const body = [
        'intro paragraph',
        '',
        '#### Nested Heading',
        '',
        '> Source: /docs/a#nested',
        '',
        'after heading',
      ].join('\n');
      const blocks = parseBlocks(body);
      const headingBlock = blocks.find(b => b.type === 'heading');
      assert.ok(headingBlock, 'heading block must be emitted');
      assert.equal(headingBlock.isLeadIn, true);
      assert.equal(headingBlock.supressCut, false);
      const sourceAsPara = blocks.find(b => b.type === 'paragraph' && b.text.startsWith('> Source:'));
      assert.equal(sourceAsPara, undefined, 'Source line must be consumed with heading');
    });
  });

  describe('isHtmlStub (Section 8 risk findings — raw HTML anchor/stub detection)', () => {
    test('<br/> standalone is a stub', () => {
      assert.equal(isHtmlStub('<br/>'), true);
    });

    test('<br> standalone is a stub', () => {
      assert.equal(isHtmlStub('<br>'), true);
    });

    test('<img src="x.png"/> standalone is a stub', () => {
      assert.equal(isHtmlStub('<img src="x.png"/>'), true);
    });

    test('<div id="foo" /> standalone is a stub', () => {
      assert.equal(isHtmlStub('<div id="foo" />'), true);
    });

    test('<span id="afterAddingData" /> standalone is a stub', () => {
      assert.equal(isHtmlStub('<span id="afterAddingData" />'), true);
    });

    test('plain paragraph text is not a stub', () => {
      assert.equal(isHtmlStub('Some regular prose here.'), false);
    });

    test('markdown link line is not a stub', () => {
      assert.equal(isHtmlStub('[Learn more](https://cap.cloud.sap)'), false);
    });

    test('non-empty paired tag is not a stub', () => {
      assert.equal(isHtmlStub('<div>content</div>'), false);
    });
  });
});
