import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { packBlocks as chunk } from '../../stages/06-packBlocks.js';
import { parseBlocks } from '../../stages/04-parse-blocks.js';
import { transformBlocks as transform } from '../../stages/05-transformBlocks.js';
import { DEFAULT_CONFIG } from '../../config.js';

function makeBlocks(body) {
  const blocks = parseBlocks(body.trim());
  for (const block of blocks) { block.text = transform(block); }
  return blocks;
}

const config = { maxChunkSize: 200, minChunkSize: 10 };

describe('chunk', () => {
  describe('basic packing', () => {
    test('short body under limit returns single chunk', () => {
      const body = 'A short paragraph well under the limit.';
      const chunks = chunk(makeBlocks(body), config.maxChunkSize);

      assert.equal(chunks.length, 1);
      assert.equal(chunks[0], 'A short paragraph well under the limit.');
    });

    test('two paragraphs exceeding limit split into two chunks', () => {
      const para = 'word '.repeat(30).trim();
      const body = `${para}\n\n${para}`;
      const chunks = chunk(makeBlocks(body), config.maxChunkSize);

      assert.equal(chunks.length, 2);
      for (const chunk of chunks) {
        assert.ok(chunk.length > 0);
      }
    });

    test('empty body returns empty array', () => {
      assert.deepEqual(chunk(makeBlocks(''), config.maxChunkSize), []);
      assert.deepEqual(chunk(makeBlocks('   \n\n  '), config.maxChunkSize), []);
    });

    test('each returned chunk is trimmed', () => {
      const para = 'word '.repeat(30).trim();
      const body = `\n\n  ${para}  \n\n${para}\n\n`;
      const chunks = chunk(makeBlocks(body), config.maxChunkSize);

      assert.ok(chunks.length > 0);
      for (const chunk of chunks) {
        assert.equal(chunk, chunk.trim());
      }
    });

    test('no chunk is empty after trim', () => {
      const para = 'word '.repeat(30).trim();
      const body = `${para}\n\n${para}\n\n${para}`;
      const chunks = chunk(makeBlocks(body), config.maxChunkSize);
      assert.ok(chunks.length > 0);
      for (const chunk of chunks) {
        assert.ok(chunk.length > 0, 'empty chunk emitted');
        assert.equal(chunk, chunk.trim(), 'chunk not trimmed');
      }
    });
  });

  describe('atomic blocks', () => {
    test('code fence larger than limit is emitted as single chunk', () => {
      const codeLines = Array.from({ length: 40 }, (_, i) => `line ${i} of code`);
      const body = ['```js', ...codeLines, '```'].join('\n');
      assert.ok(body.length > config.maxChunkSize);

      const chunks = chunk(makeBlocks(body), config.maxChunkSize);

      assert.equal(chunks.length, 1);
      assert.match(chunks[0], /^```js/);
      assert.match(chunks[0], /```$/);
      assert.match(chunks[0], /line 39 of code/);
    });

    test('4-backtick fence is not split by inner 3-backtick closer', () => {
      const body = [
        '````md',
        '```js',
        'inner code',
        '```',
        'more md content',
        '````',
        '',
        'after paragraph',
      ].join('\n');
      const chunks = chunk(makeBlocks(body), 2000);
      assert.ok(chunks[0].startsWith('````md'));
      assert.ok(chunks[0].includes('inner code'));
      assert.ok(chunks[0].includes('more md content'));
    });

    test('~~~ fence is recognised and kept atomic', () => {
      const codeLines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
      const body = ['~~~sh', ...codeLines, '~~~'].join('\n');
      assert.ok(body.length > 200);
      const chunks = chunk(makeBlocks(body), config.maxChunkSize);
      assert.equal(chunks.length, 1);
      assert.match(chunks[0], /^~~~sh/);
      assert.match(chunks[0], /~~~$/);
    });

    test('fence with indented closer is recognised', () => {
      const body = [
        '```zsh',
        'npm install',
        '  ```',
        '',
        'paragraph after',
      ].join('\n');
      const chunks = chunk(makeBlocks(body), 2000);
      assert.ok(chunks[0].includes('```zsh'), 'fence opener must be present');
      assert.ok(chunks[0].includes('npm install'), 'fence content must be present');
    });

    test('bullet list is kept atomic and not split mid-list', () => {
      const items = Array.from({ length: 17 }, (_, i) => `- Item ${i}: Add/override annotations and extend the base app`);
      const body = items.join('\n');
      assert.ok(body.length > config.maxChunkSize);
      const chunks = chunk(makeBlocks(body), config.maxChunkSize);
      assert.equal(chunks.length, 1, 'bullet list must not be split');
    });

    test('bullet list with blank lines between items stays atomic', () => {
      const body = [
        '- item one with some additional content to push length up',
        '',
        '- item two with some additional content to push length up',
        '',
        '- item three with some additional content to push length up',
        '',
        '- item four with some additional content to push length up',
      ].join('\n');
      assert.ok(body.length > config.maxChunkSize);
      const chunks = chunk(makeBlocks(body), config.maxChunkSize);
      assert.equal(chunks.length, 1, 'bullet list with blank-line gaps must not be split');
    });

    test('numbered list is kept atomic — no cut between items', () => {
      const body = `This section summarizes best practices for implementing event handlers.

1. On which service should I register my event handler?

    Event handlers implementing business logic should be registered on an Application Service.
    When implementing technical requirements, you can register on the Persistence Service.

2. Which services should my event handlers usually interact with?

    The CAP Java SDK provides APIs that can be used in event handlers to interact with other services.
    These other services can be used to request data required by the event handler implementation.

3. How should I implement business logic shared across services?

    In general, design your services with specific use cases in mind. Nevertheless, it might be necessary
    to share certain business logic across multiple services using utility methods.`;

      const chunks = chunk(makeBlocks(body), config.maxChunkSize);

      const item1 = chunks.find(c => c.includes('1.'));
      const item2 = chunks.find(c => c.includes('2.'));
      const item3 = chunks.find(c => c.includes('3.'));
      assert.ok(item1 && item2 && item3, 'all items must appear in some chunk');
      assert.equal(item1, item2, 'items 1 and 2 must be in the same chunk');
      assert.equal(item2, item3, 'items 2 and 3 must be in the same chunk');
    });

    test('numbered list with indented continuation after blank line stays atomic', () => {
      const body = [
        '1. First item short',
        '',
        '   Indented continuation of first item that adds more detail.',
        '',
        '2. Second item short',
        '',
        '   Indented continuation of second item that also adds detail.',
      ].join('\n');
      const chunks = chunk(makeBlocks(body), 2000);
      assert.equal(chunks.length, 1, 'numbered list with indented continuations must be atomic');
      assert.ok(chunks[0].includes('1.'));
      assert.ok(chunks[0].includes('2.'));
      assert.ok(chunks[0].includes('Indented continuation of second item'));
    });

    test('markdown pipe table is kept atomic and not split', () => {
      const rows   = Array.from({ length: 20 }, (_, i) => `| Row ${i} | val | val | val | val |`);
      const table  = ['| Feature | CQL | GraphQL | OData | SQL |', '| - | :-: | :-: | :-: | :-: |', ...rows].join('\n');
      assert.ok(table.length > config.maxChunkSize);
      const chunks = chunk(makeBlocks(table), config.maxChunkSize);
      assert.equal(chunks.length, 1);
      assert.ok(chunks[0].includes('Feature'));
      assert.ok(chunks[0].includes(`Row ${rows.length - 1}`));
    });

    test('HTML <table> block is kept atomic and not split', () => {
      const rows = Array.from({ length: 20 }, (_, i) => `  <tr><td>col${i}</td><td>value${i}</td></tr>`);
      const table = ['<table>', '  <thead><tr><th>Col</th><th>Val</th></tr></thead>', ...rows, '</table>'].join('\n');
      assert.ok(table.length > config.maxChunkSize);
      const chunks = chunk(makeBlocks(table), config.maxChunkSize);
      assert.equal(chunks.length, 1);
      assert.ok(chunks[0].includes('col0'));
      assert.ok(chunks[0].includes('col19'));
    });

    test('GFM admonition blockquote with nested fence is kept atomic', () => {
      const body = [
        '> [!tip] How to enable reuse packages',
        '> The `@capire/common` package uses the `cds-plugin.js` technique.',
        '> ```json',
        '> { "cds": { "requires": { "common": "@capire/common" } } }',
        '> ```',
        '',
        'Paragraph after the admonition.',
      ].join('\n');
      const chunks = chunk(makeBlocks(body), config.maxChunkSize);
      const admonChunk = chunks.find(c => c.includes('[!tip]'));
      assert.ok(admonChunk, 'expected chunk with admonition');
      const fenceCount = (admonChunk.match(/```/g) || []).length;
      assert.equal(fenceCount % 2, 0, 'nested fence must be intact inside admonition');
    });

    test('GFM admonition block is atomic — not split between lines', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `> line ${i} of admonition content`);
      const body = [
        '> [!warning] Important',
        ...lines,
        '',
        'paragraph after',
      ].join('\n');
      const chunks = chunk(makeBlocks(body), config.maxChunkSize);
      const admonChunk = chunks.find(c => c.includes('[!warning]'));
      assert.ok(admonChunk, 'expected admonition chunk');
      assert.ok(admonChunk.includes('line 9 of admonition content'), 'last admonition line must be in same chunk');
    });

    test('<div class="cols-N"> block is collected atomically', () => {
      const body = [
        'before paragraph',
        '',
        '<div class="cols-2">',
        '',
        '```js',
        'const a = 1;',
        '```',
        '',
        '</div>',
        '',
        'after paragraph',
      ].join('\n');
      const chunks = chunk(makeBlocks(body), 2000);
      assert.ok(chunks[0].includes('const a = 1;'), 'content inside cols div must be intact');
    });

    test('nested div inside impl-java div is depth-tracked correctly', () => {
      const body = [
        'before text',
        '',
        '<div class="impl java">',
        '',
        '<div class="inner">',
        'nested content',
        '</div>',
        '',
        '</div>',
        '',
        'after text',
      ].join('\n');
      const chunks = chunk(makeBlocks(body), 2000);
      const divChunk = chunks.find(c => c.includes('Java:'));
      assert.ok(divChunk, 'expected chunk with impl div (transformed to Java:)');
      assert.ok(divChunk.includes('nested content'), 'nested div content must be inside outer div chunk');
    });
  });

  describe('cut-point suppression', () => {
    test('code fence followed by anaphoric paragraph stays in one chunk', () => {
      const codeLines = Array.from({ length: 40 }, (_, i) => `line ${i} of code`);
      const code = ['```js', ...codeLines, '```'].join('\n');
      const para = 'These are the results produced by the code above.';
      const body = `${code}\n\n${para}`;
      const chunks = chunk(makeBlocks(body), config.maxChunkSize);
      assert.equal(chunks.length, 1);
      assert.match(chunks[0], /```js/);
      assert.ok(chunks[0].includes(para));
    });

    test('cut-point suppressed when next line is a fence opener', () => {
      const para = 'word '.repeat(20).trim();
      const code = ['```js', 'let x = 1;', '```'].join('\n');
      const body = `${para}\n\n${code}\n\nparagraph after`;
      const chunks = chunk(makeBlocks(body), 120);
      const fenceChunk = chunks.find(c => c.includes('```js'));
      assert.ok(fenceChunk, 'expected chunk containing fence opener');
      assert.ok(fenceChunk.includes('let x = 1;'), 'fence content must be in same chunk as opener');
    });

    test('cut-point suppressed when next line is a ::: container opener', () => {
      const para = 'word '.repeat(20).trim();
      const body = `${para}\n\n::: tip\nsome tip content here\n:::\n\nparagraph after`;
      const chunks = chunk(makeBlocks(body), 120);
      const containerChunk = chunks.find(c => c.includes('some tip content here'));
      assert.ok(containerChunk, 'expected chunk containing container content');
      assert.ok(containerChunk.includes('some tip content here'), 'container content must be in same chunk as opener');
    });

    test('cut-point suppressed when next paragraph starts with anaphoric word', () => {
      const para = 'word '.repeat(10).trim();
      const anaphoricCases = [
        'These are the values returned by the method above.',
        'Those settings apply only when the service is in production mode.',
        'They are defined in the configuration file as shown.',
      ];
      for (const anaphoric of anaphoricCases) {
        const body = `${para}\n\n${anaphoric}`;
        const chunks = chunk(makeBlocks(body), 200);
        assert.equal(chunks.length, 1, `"${anaphoric.slice(0, 40)}" must stay with referent`);
      }
    });

    test('cut-point suppressed when prev line was a fence opener', () => {
      const para = 'word '.repeat(20).trim();
      const body = [`${para}`, '', '```js', '', 'let x = 1;', '```', '', 'after'].join('\n');
      const chunks = chunk(makeBlocks(body), 120);
      const fenceChunk = chunks.find(c => c.includes('```js'));
      assert.ok(fenceChunk && fenceChunk.includes('let x = 1;'), 'blank after fence opener must not split fence');
    });

    test('html stub lines skipped when finding next non-blank line for cut-point check', () => {
      const para = 'word '.repeat(20).trim();
      const body = `${para}\n\n<UnderConstruction/>\n\n${para}`;
      const chunks = chunk(makeBlocks(body), 120);
      assert.ok(chunks.length > 0);
      for (const c of chunks) assert.ok(c.trim().length > 0);
    });

    test('cut-point suppressed when prev line is a lead-in (colon, as shown, the following, etc.)', () => {
      const para = 'word '.repeat(10).trim();
      const cases = [
        'The following shows:',
        'The following configuration options are available:',
        'An example is shown below',
        'The setup is described as follows',
        'You can configure it like this',
        'The result is listed below',
        'As shown above',
        'In the following, we show you how to implement a `cds add` plugin for PostgreSQL support.',
      ];
      for (const leadIn of cases) {
        const body = `${para}\n\n${leadIn}\n\n${para}`;
        const chunks = chunk(makeBlocks(body), 200);
        assert.equal(chunks.length, 1, `lead-in "${leadIn}" must not be separated from its content`);
      }
    });

    test('"Note that" paragraph suppresses cut', () => {
      const para = 'word '.repeat(10).trim();
      const body = `${para}\n\nNote that this applies only when the service is active.`;
      const chunks = chunk(makeBlocks(body), 200);
      assert.equal(chunks.length, 1, '"Note that" must suppress cut before it');
    });

    test('"Note:" paragraph suppresses cut', () => {
      const para = 'word '.repeat(10).trim();
      const body = `${para}\n\nNote: this is an important caveat about behavior.`;
      const chunks = chunk(makeBlocks(body), 200);
      assert.equal(chunks.length, 1, '"Note:" must suppress cut before it');
    });

    test('"In this" paragraph suppresses cut', () => {
      const para = 'word '.repeat(10).trim();
      const body = `${para}\n\nIn this section, we explain how to configure the service.`;
      const chunks = chunk(makeBlocks(body), 200);
      assert.equal(chunks.length, 1, '"In this" must suppress cut before it');
    });

    test('lead-in "as shown below" mid-sentence suppresses cut', () => {
      const prev = 'For upgrades to work, use open version ranges as shown below in your config, combined with package-lock.json for repeatable builds.';
      const next = 'Independent paragraph with no intro relationship to the above.';
      const body = `${prev}\n\n${next}`;
      const chunks = chunk(makeBlocks(body), 140);
      assert.equal(chunks.length, 1, '"as shown below" mid-sentence should suppress cut');
    });

    test('lead-in "the following" mid-sentence suppresses cut', () => {
      const prev = 'We offer support for the following frameworks on all major platforms and operating systems.';
      const next = 'Independent paragraph with no intro relationship to the above sentence.';
      const body = `${prev}\n\n${next}`;
      const chunks = chunk(makeBlocks(body), 140);
      assert.equal(chunks.length, 1, '"the following" mid-sentence should suppress cut');
    });

    test('lead-in "like this" mid-sentence suppresses cut', () => {
      const prev = 'We do not want to configure it like this in production; prefer the environment variable approach.';
      const next = 'Independent paragraph with no intro relationship to the above.';
      const body = `${prev}\n\n${next}`;
      const chunks = chunk(makeBlocks(body), 140);
      assert.equal(chunks.length, 1, '"like this" mid-sentence should suppress cut');
    });

    test('lead-in: prev block last line ends with colon via HTML stub skip', () => {
      const para = 'word '.repeat(10).trim();
      const leadInBlock = `Here is the configuration:\n<SomeComponent/>`;
      const body = `${para}\n\n${leadInBlock}\n\n${para}`;
      const chunks = chunk(makeBlocks(body), 200);
      assert.equal(chunks.length, 1, 'HTML stub after lead-in must not mask the lead-in');
    });
  });

  describe('lead-in and table context', () => {
    test('markdown pipe table with intro stays together (lead-in suppresses cut)', () => {
      const rows   = Array.from({ length: 5 }, (_, i) => `| Row ${i} | val | val | val | val |`);
      const table  = ['| Feature | CQL | GraphQL | OData | SQL |', '| - | :-: | :-: | :-: | :-: |', ...rows].join('\n');
      const intro  = 'The following table compares query language features:';
      const body   = `${intro}\n\n${table}`;
      const chunks = chunk(makeBlocks(body), 300);
      const tableChunk = chunks.find(c => c.includes('Feature'));
      assert.ok(tableChunk, 'expected chunk with pipe table');
      assert.ok(tableChunk.includes(intro), 'intro must be in same chunk as table');
    });

    test('HTML <table> surrounding context — intro kept with table, no cut inside', () => {
      const rows = Array.from({ length: 20 }, (_, i) => `  <tr><td>col${i}</td><td>value${i}</td></tr>`);
      const table = ['<table>', '  <thead><tr><th>Col</th><th>Val</th></tr></thead>', ...rows, '</table>'].join('\n');
      const intro = 'The following table lists all configuration properties:';
      const outro = 'Use these properties to configure your service.';
      const body = `${intro}\n\n${table}\n\n${outro}`;

      const chunks = chunk(makeBlocks(body), config.maxChunkSize);

      const tableChunk = chunks.find(c => c.includes('col0'));
      assert.ok(tableChunk, 'expected chunk with table content');
      assert.ok(tableChunk.includes(intro), 'intro must be in same chunk as table');
      assert.ok(tableChunk.includes('col19'), 'all rows must be in same chunk');
    });
  });

  describe('impl div cut behavior', () => {
    test('<div class="impl java/node"> block does NOT suppress cut before it (supressCut=false)', () => {
      const para = 'word '.repeat(40).trim();
      const div = [
        '<div class="impl node">',
        '',
        'node-specific content here',
        '',
        '</div>',
      ].join('\n');
      const body = `${para}\n\n${div}`;
      const chunks = chunk(makeBlocks(body), 200);
      const divChunk = chunks.find(c => c.includes('Node.js:'));
      const paraChunk = chunks.find(c => c.includes('word'));
      assert.ok(divChunk, 'expected chunk with impl node div (transformed to Node.js:)');
      assert.ok(paraChunk, 'expected chunk with para');
      assert.ok(divChunk !== paraChunk, 'impl div must not suppress cut — para and div in separate chunks');
    });

    test('<div class="impl java/node"> block always starts a new chunk', () => {
      const before = 'before '.repeat(30).trim();
      const after  = 'after '.repeat(20).trim();
      const div = [
        '<div class="impl java">',
        '',
        '```sh',
        'mvn spring-boot:run',
        '```',
        '',
        '</div>',
      ].join('\n');
      const body = `${before}\n\n${div}\n\n${after}`;
      const chunks = chunk(makeBlocks(body), 200);
      const divChunk = chunks.find(c => c.includes('Java:'));
      assert.ok(divChunk, 'expected chunk with div (transformed to Java:)');
      assert.ok(divChunk.includes('mvn spring-boot:run'), 'fence inside div must be intact');
      assert.ok(!divChunk.includes(before), 'para before div must not be in div chunk');
    });
  });

  describe('container variants', () => {
    test(':::code-group (no space) is recognised as container opener', () => {
      const body = [
        ':::code-group',
        '```js [Node.js]',
        'const x = 1;',
        '```',
        ':::',
        '',
        'paragraph after',
      ].join('\n');
      const chunks = chunk(makeBlocks(body), 2000);
      assert.ok(chunks[0].includes('const x = 1;'), 'container content must be present');
    });

    test(':::: closer closes container opened with :::', () => {
      const body = [
        '::: tip some tip',
        'tip content here',
        '::::',
        '',
        'paragraph after',
      ].join('\n');
      const chunks = chunk(makeBlocks(body), 2000);
      assert.ok(chunks[0].includes('tip content here'), 'container content must be present');
    });

    test('nested container — inner ::: closes all (depth=0 rule)', () => {
      const codeLines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
      const body = [
        '::: details outer',
        '::: code-group',
        '```js',
        ...codeLines,
        '```',
        ':::',
        'paragraph after outer',
      ].join('\n');
      const chunks = chunk(makeBlocks(body), 2000);
      assert.ok(chunks[0].includes('line 0'), 'fence content must be present');
      assert.ok(chunks[0].includes('paragraph after outer'), 'content after closer must be in same chunk');
    });
  });

  describe('carry-back', () => {
    test('carry-back: suppressed cut causes prev block to be carried to new chunk', () => {
      const para1 = 'alpha '.repeat(18).trim();
      const para2 = 'beta '.repeat(18).trim();
      const para3 = 'These gamma word is an anaphoric continuation that adds more detail here.';
      const body = `${para1}\n\n${para2}\n\n${para3}`;
      const chunks = chunk(makeBlocks(body), 200);
      assert.equal(chunks.length, 2, 'carry-back must split into 2 chunks');
      assert.ok(chunks[0].includes('alpha'), 'chunk 0 must have para1');
      assert.ok(!chunks[0].includes('beta'), 'chunk 0 must not have para2');
      assert.ok(chunks[1].includes('beta'), 'chunk 1 must have para2');
      assert.ok(chunks[1].includes('These gamma'), 'chunk 1 must have anaphoric para3');
    });
  });

  describe('real-world patterns', () => {
    test('<span> before fence opener not treated as meaningful prev line', () => {
      const body = `> Source: /docs/guides/integration/data-federation#motivation

There are many scenarios where data from remote services needs to be in close access locally. For example when we display lists of local data joined with remote data, as we introduce in the [*CAP-level Service Integration*](calesi.md#integration-logic-required) guide:

![XTravels Fiori list view showing a table of travel requests, with the Customer column empty.](assets/xtravels-list-.png)

![XTravels Fiori details view showing a travel requests, with the flights data missing](assets/xtravels-bookings-.png)

When we run that and look into the log output of the xtravels app server, we see some bulk requests as shown below, which indicates that the Fiori client is desparately trying to fetch the missing customer data. If we'd scroll the list in the UI this would repeat like crazy.

<span>

\`\`\`js
[odata] - POST /odata/v4/travel/$batch
[odata] - > GET /Travels(ID=4133,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4132,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4131,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4130,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4129,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4128,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4127,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4126,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4125,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4124,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4123,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4122,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4121,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4120,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4119,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4118,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4117,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4116,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4115,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4114,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4113,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4112,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4111,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4110,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4109,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4108,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4107,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4106,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4105,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4104,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
\`\`\`
</span>

Relying on live calls to remote services per row is clearly not an option. Instead, we'd rather ensure that data required in close access is really available locally, so it can be joined with own data using SQL JOINs. This is what _data federation_ is all about.`;

      const chunks = chunk(makeBlocks(body), 512*3);

      for (const chunk of chunks) {
        const count = (chunk.match(/```/g) || []).length;
        assert.equal(count % 2, 0, `unclosed fence in chunk: ${chunk.slice(0, 80)}`);
      }
      const fenceChunk = chunks.find(c => c.includes('```js'));
      assert.equal(chunks.length, 2, 'must be split into 2 chunks');
      assert.ok(fenceChunk, 'expected chunk with fence');
      assert.ok(fenceChunk.includes('[odata]'), 'fence content must be in same chunk as opener');
    });
  });

  describe('flowchart gap-fills', () => {
    test('chunk([]) returns empty array', () => {
      assert.deepEqual(chunk([], 100), []);
    });

    test('single block larger than maxChunkSize emits one over-sized chunk', () => {
      const big = { text: 'x'.repeat(500), type: 'paragraph', supressCut: false };
      const chunks = chunk([big], 100);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].length, 500);
    });

    test('suppressed cut on second block with current of size 1 appends over max', () => {
      const first  = { text: 'a'.repeat(90), type: 'paragraph', supressCut: false };
      const second = { text: '```\ncode block bigger than remaining space\n```', type: 'fence', supressCut: true };
      const chunks = chunk([first, second], 100);
      assert.equal(chunks.length, 1, 'must not split since cut is suppressed and no earlier cut is available');
      assert.ok(chunks[0].includes('code block'));
    });

    test('carry-back does not duplicate carried block across chunks', () => {
      const A = { text: 'A'.repeat(80), type: 'paragraph', supressCut: false, isLeadIn: false, isAnaphoric: false };
      const B = { text: 'B'.repeat(30), type: 'paragraph', supressCut: false, isLeadIn: false, isAnaphoric: false };
      const C = { text: '```\nCcc\n```', type: 'fence', supressCut: true };
      const chunks = chunk([A, B, C], 100);
      assert.equal(chunks.length, 2);
      assert.ok(chunks[0].includes('A'.repeat(80)) && !chunks[0].includes('B'.repeat(30)),
        `chunk 0 should have only A; got: ${chunks[0]}`);
      assert.ok(chunks[1].includes('B'.repeat(30)) && chunks[1].includes('Ccc'),
        `chunk 1 should have B and C; got: ${chunks[1]}`);
      const bCount = (chunks.join('|').match(/B{30}/g) || []).length;
      assert.equal(bCount, 1, 'B must appear in exactly one chunk');
    });

    test('block containing only whitespace produces no chunks', () => {
      const b = { text: '   \n\n   ', type: 'paragraph', supressCut: false };
      const chunks = chunk([b], 100);
      assert.deepEqual(chunks, []);
    });

    test('cut is suppressed when supressCut, isAnaphoric, and prev.isLeadIn all true', () => {
      const prev = { text: 'p'.repeat(90), type: 'paragraph', supressCut: false, isLeadIn: true, isAnaphoric: false };
      const next = { text: '```\nnext\n```', type: 'fence', supressCut: true, isAnaphoric: true };
      const chunks = chunk([prev, next], 100);
      assert.equal(chunks.length, 1, 'all three suppress conditions ⇒ one chunk');
    });
  });
});
