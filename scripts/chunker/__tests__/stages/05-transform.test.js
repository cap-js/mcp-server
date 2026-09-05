import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { transformBlocks as transform } from '../../stages/05-transformBlocks.js';
import { parseBlocks } from '../../stages/04-parse-blocks.js';

function block(type, text) {
  return { type, text, supressCut: false };
}

function itemBlock(text) {
  return parseBlocks(text)[0];
}

describe('transform', () => {
  describe('normalizeProse (paragraph / heading / redirect pipeline)', () => {
    test('applies full pipeline: normalize, strip markers, strip jsx, strip images, decode, collapse spaces, resolve links', () => {
      const b = block('paragraph', 'See  <Tip>note</Tip>  &amp;  [guide](../guide.md)');
      const result = transform(b, '> Source: /docs/java/ref.md');
      assert.ok(!result.includes('<Tip>'), 'jsx stripped');
      assert.ok(result.includes('Tip: note'), 'Tip content prefixed');
      assert.ok(result.includes('&'), 'entity decoded');
      assert.ok(result.includes('guide (/docs/guide)'), 'link resolved: ' + result);
      assert.ok(!result.includes('  '), 'double spaces collapsed');
    });

    test('heading and redirect use same pipeline as paragraph', () => {
      const bh = block('heading', '## Title {.class} ![x](y.png)');
      const br = block('redirect', 'Redirect {.note} text');
      assert.equal(transform(bh), '## Title');
      assert.equal(transform(br), 'Redirect text');
    });
  });

  describe('paragraph', () => {
    test('collapses multi-space runs', () => {
      const b = block('paragraph', 'Some text   with   unnecessary spacing.');
      assert.equal(transform(b), 'Some text with unnecessary spacing.');
    });

    test('preserves wording exactly', () => {
      const input = 'Do not rewrite or paraphrase this content.';
      const b = block('paragraph', input);
      assert.equal(transform(b), input);
    });

    test('does not collapse spaces inside backtick spans', () => {
      const b = block('paragraph', 'run `npm   install` now');
      assert.equal(transform(b), 'run `npm   install` now');
    });

    test('(deprecated) inline text preserved unchanged', () => {
      const b = block('paragraph', 'Use cds.serve (deprecated) instead.');
      assert.ok(transform(b).includes('(deprecated)'), '(deprecated) parenthetical must survive normalizeProse');
    });

    test('remove <Config>', () => {
      const b = block('paragraph', 'Middleware in <Config>cds.requires.auth.impl</Config>, by providing a path relative to the project root.');
      assert.ok(transform(b) === 'Middleware in cds.requires.auth.impl, by providing a path relative to the project root.');
    });
  });

  describe('fence', () => {
    test('preserves inner content verbatim', () => {
      const code = '```js\nconst foo =   bar()\n  indented()\n```';
      const b = block('fence', code);
      assert.equal(transform(b), code);
    });

    test('non-log fence content preserved exactly', () => {
      const code = '```js\n[cds] - repeated\n[cds] - repeated\n[cds] - repeated\n[cds] - repeated\n[cds] - repeated\n[cds] - repeated\n```';
      const b = block('fence', code);
      assert.equal(transform(b), code);
    });

    test('log fence without [!code focus]: collapses path runs > 3', () => {
      const paths = [
        '   gen/db/src/gen/AdminService.Authors.hdbview',
        '   gen/db/src/gen/AdminService.Books.hdbview',
        '   gen/db/src/gen/AdminService.Genres.hdbview',
        '   gen/db/src/gen/CatalogService.Books.hdbview',
        '   gen/db/src/gen/CatalogService.Genres.hdbview',
      ];
      const text = '```log\n[cds] - done > wrote output to:\n' + paths.join('\n') + '\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.includes(paths[0]), 'first path kept');
      assert.ok(result.includes(paths[paths.length - 1]), 'last path kept');
      assert.ok(result.includes('   ...'), 'summary inserted');
      assert.ok(!result.includes(paths[2]), 'middle paths removed');
    });

    test('log fence: path run of 3 or fewer not collapsed', () => {
      const paths = [
        '   gen/db/src/gen/A.hdbview',
        '   gen/db/src/gen/B.hdbview',
        '   gen/db/src/gen/C.hdbview',
      ];
      const text = '```log\n[cds] - done:\n' + paths.join('\n') + '\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.includes(paths[1]), 'middle path kept when <=3');
    });

    test('log fence: different dirs form separate groups', () => {
      const text = '```log\n[cds] - done:\n   gen/a/file1.txt\n   gen/a/file2.txt\n   gen/a/file3.txt\n   gen/a/file4.txt\n   gen/b/file1.txt\n   gen/b/file2.txt\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.includes('gen/a/file1.txt'), 'first of group a');
      assert.ok(result.includes('gen/a/file4.txt'), 'last of group a');
      assert.ok(result.includes('gen/b/file1.txt'), 'group b (<=3, all kept)');
      assert.ok(result.includes('gen/b/file2.txt'), 'group b kept');
    });

    test('log fence with [!code focus]: keeps only marked lines', () => {
      const text = '```log\n[cds] - done > wrote output to:\n   gen/db/init.js // [!code focus]\n   gen/db/package.json\n   gen/db/src/gen/AdminService.Authors.hdbview // [!code focus]\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.includes('gen/db/init.js'), 'focused line kept');
      assert.ok(result.includes('AdminService.Authors.hdbview'), 'focused line kept');
      assert.ok(!result.includes('gen/db/package.json'), 'unfocused line dropped');
      assert.ok(!result.includes('[!code focus]'), 'marker stripped from output');
    });

    test('log fence with [!code focus]: opener and closer preserved', () => {
      const text = '```log\nsome line // [!code focus]\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.startsWith('```log'), 'opener preserved');
      assert.ok(result.endsWith('```'), 'closer preserved');
    });

    test('log fence with Python # [!code focus]: keeps only marked lines, strips marker', () => {
      const text = '```log\n[cds] - done:\n   gen/db/init.py # [!code focus]\n   gen/db/other.py\n   gen/db/keep.py # [!code focus]\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.includes('gen/db/init.py'), 'python focused line kept');
      assert.ok(result.includes('gen/db/keep.py'), 'second python focused line kept');
      assert.ok(!result.includes('gen/db/other.py'), 'unfocused line dropped');
      assert.ok(!result.includes('[!code focus]'), 'marker stripped from output');
    });

    test('idempotent', () => {
      const code = '```js\nconst x = 1\n```';
      const b1 = block('fence', code);
      const first = transform(b1);
      const b2 = block('fence', first);
      assert.equal(transform(b2), first);
    });

    test('normalizes only line endings, not content', () => {
      const b = block('fence', '```\r\nfoo()\r\n```');
      assert.equal(transform(b), '```\nfoo()\n```');
    });

    test('[!code --] in non-log fence preserved verbatim', () => {
      const text = '```js\nconst x = 1 // [!code --]\nconst x = 2\n```';
      const b = block('fence', text);
      assert.ok(transform(b).includes('[!code --]'), '[!code --] diff marker must survive non-log fence transform');
    });

    test('[!code ++] in non-log fence preserved verbatim', () => {
      const text = '```js\nconst x = 1\nconst x = 2 // [!code ++]\n```';
      const b = block('fence', text);
      assert.ok(transform(b).includes('[!code ++]'), '[!code ++] diff marker must survive non-log fence transform');
    });
  });

  describe('shared normalization', () => {
    test('collapses 3+ blank lines to 2', () => {
      const b = block('paragraph', 'a\n\n\n\nb');
      assert.equal(transform(b), 'a\n\nb');
    });

    test('removes HTML stub lines', () => {
      const b = block('paragraph', 'text\n<br/>\nmore');
      const result = transform(b);
      assert.ok(!result.includes('<br/>'), 'stub line removed');
      assert.ok(result.includes('text'), 'real content kept');
      assert.ok(result.includes('more'), 'real content kept');
    });

    test('keeps non-stub HTML', () => {
      const b = block('paragraph', 'See the <a href="/docs">docs</a> here.');
      const result = transform(b);
      assert.ok(result.includes('<a href="/docs">'), 'anchor kept');
    });

    test('trims leading and trailing whitespace', () => {
      const b = block('paragraph', '  \n\nactual content\n\n  ');
      assert.equal(transform(b), 'actual content');
    });

    test('normalizes CRLF line endings', () => {
      const b = block('paragraph', 'line one\r\nline two');
      assert.equal(transform(b), 'line one\nline two');
    });

    test('strips trailing {...} attr block before stub test', () => {
      // '<br/> {.class}' — without stripTrailingAttrBlock the {.class} would prevent stub detection
      const b = block('paragraph', 'text\n<br/> {.class}\nmore');
      const result = transform(b);
      assert.ok(!result.includes('<br/>'), 'stub line with trailing attr dropped');
      assert.ok(result.includes('text'), 'real content kept');
      assert.ok(result.includes('more'), 'real content kept');
    });

    test('stripTrailingAttrBlock strips {lang=js} and {key="v"} not just {.class}', () => {
      const b = block('paragraph', 'text\n<div> {lang=js}\nmore');
      const result = transform(b);
      assert.ok(!result.includes('<div>'), 'stub line with arbitrary attr dropped');
    });

    test('<iframe src="url"> in paragraph converted to video (url) not dropped', () => {
      const url = 'https://www.youtube.com/embed/abc123';
      const b = block('paragraph', `text\n<iframe src="${url}" allowfullscreen></iframe>\nmore`);
      const result = transform(b);
      assert.ok(result.includes(`video (${url})`), `iframe converted: ${result}`);
      assert.ok(result.includes('text'), 'surrounding text kept');
    });

    test('<iframe> inner description text preserved with URL as video (url): desc', () => {
      const b = block('paragraph', '<iframe src="/demo/video">Watch this video about setup</iframe>');
      assert.equal(transform(b), 'video (/demo/video): Watch this video about setup');
    });

    test('<div id="anchor" /> stub line dropped, surrounding content kept', () => {
      const b = block('paragraph', '<div id="events" />\nReal content follows.');
      const result = transform(b);
      assert.ok(!result.includes('<div id='), 'anchor stub dropped');
      assert.ok(result.includes('Real content follows.'), 'surrounding content kept');
    });

    test('<span id="afterAddingData" /> stub line dropped, surrounding content kept', () => {
      const b = block('paragraph', '<span id="afterAddingData" />\nContent after anchor.');
      const result = transform(b);
      assert.ok(!result.includes('<span id='), 'span anchor stub dropped');
      assert.ok(result.includes('Content after anchor.'), 'surrounding content kept');
    });

    test('> Source: line embedded in paragraph body passes through as blockquote prose', () => {
      const b = block('paragraph', 'Background info.\n> Source: /docs/guides/foo\nMore text.');
      const result = transform(b);
      assert.ok(result.includes('> Source: /docs/guides/foo'), 'source line preserved as blockquote');
    });
  });

  describe('class markers (G1)', () => {
    test('strips {.class} from paragraph', () => {
      const b = block('paragraph', 'Some text {.tip} here.');
      assert.equal(transform(b), 'Some text here.');
    });

    test('strips {#id} from paragraph', () => {
      const b = block('paragraph', 'Heading content {#my-anchor}');
      assert.equal(transform(b), 'Heading content');
    });

    test('strips {.class #id} combined marker', () => {
      const b = block('paragraph', 'Text {.warning #warn-1} more.');
      assert.equal(transform(b), 'Text more.');
    });

    test('strips <UnderConstruction/> tag', () => {
      const b = block('paragraph', 'This feature <UnderConstruction/> is coming.');
      assert.equal(transform(b), 'This feature is coming.');
    });

    test('preserves {.class} inside backtick span', () => {
      const b = block('paragraph', 'Use `{.class}` in your template.');
      assert.ok(transform(b).includes('`{.class}`'), 'inline code preserved');
    });

    test('strips {.class} from bullet-item opener', () => {
      const b = itemBlock('- item one {.active}');
      const result = transform(b);
      assert.ok(!result.includes('{.active}'), 'marker stripped');
      assert.ok(result.includes('item one'), 'content kept');
    });

    test('line that becomes empty after stripping is dropped', () => {
      const b = block('paragraph', 'real content\n{.orphan-marker}\nmore content');
      const result = transform(b);
      assert.ok(!result.includes('{.orphan-marker}'), 'marker line dropped');
      assert.ok(result.includes('real content'), 'content kept');
      assert.ok(result.includes('more content'), 'content kept');
    });

    test('blank lines between content preserved', () => {
      const b = block('paragraph', 'a\n\nb');
      assert.equal(transform(b), 'a\n\nb');
    });

    test('strips {.good}, {.bad}, {.abstract} structural role markers from paragraph', () => {
      assert.equal(transform(block('paragraph', 'Some good example. {.good}')), 'Some good example.');
      assert.equal(transform(block('paragraph', 'Avoid this. {.bad}')), 'Avoid this.');
      assert.equal(transform(block('paragraph', 'Overview text. {.abstract}')), 'Overview text.');
    });

    test('{target="_blank"} trailing attr stripped from link', () => {
      const b = block('paragraph', '[Learn more](/docs/guide){target="_blank"}');
      assert.equal(transform(b), 'Learn more (/docs/guide)');
    });

    test('{#entities} stripped from heading block, heading text kept', () => {
      const b = block('heading', '## CDS Entities {#entities}');
      const result = transform(b);
      assert.ok(!result.includes('{#entities}'), '{#entities} anchor stripped from heading');
      assert.ok(result.includes('CDS Entities'), 'heading text kept');
    });
  });

  describe('heading extras (stripHeadingExtras)', () => {
    test('strips inline image from heading', () => {
      const b = block('heading', '## Title ![x](img.svg)');
      assert.equal(transform(b), '## Title');
    });

    test('decodes numeric HTML entity in heading', () => {
      const b = block('heading', '## Title &#8594; Next');
      assert.equal(transform(b), '## Title → Next');
    });

    test('decodes numeric entity in heading (re:cap brand name)', () => {
      const b = block('heading', '## re&#8829;cap 26');
      assert.equal(transform(b), '## re≽cap 26');
    });

    test('strips remaining {} from heading', () => {
      const b = block('heading', '## Title {}');
      assert.equal(transform(b), '## Title');
    });

    test('keeps the beta in heading', () => {
      const b = block('heading', '#### Native Fetch Client <Beta />');
      assert.equal(transform(b), '#### Native Fetch Client (Beta)');
    });

    test('does not strip inline image from paragraph (heading-only concern)', () => {
      const b = block('paragraph', 'See ![diagram](img.svg) for details');
      assert.ok(transform(b).includes('diagram'), 'alt text kept in paragraph');
    });
  });

  describe('normalizeListItem (bullet-item / list-item pipeline)', () => {
    test('strips markers, jsx, images, inline html, decodes entities, resolves links', () => {
      const b = itemBlock('- <Tip>note</Tip> {.class} <em>text</em> &amp; [x](../g.md)');
      const result = transform(b, '> Source: /docs/java/ref.md');
      assert.ok(!result.includes('<Tip>'), 'jsx stripped');
      assert.ok(!result.includes('{.class}'), 'marker stripped');
      assert.ok(!result.includes('<em>'), 'inline html stripped');
      assert.ok(result.includes('&'), 'entity decoded');
      assert.ok(result.includes('x (/docs/g)'), 'link resolved: ' + result);
    });

    test('list-item uses same pipeline as bullet-item', () => {
      const b = itemBlock('1. item <Badge/> text');
      const result = transform(b);
      assert.ok(!result.includes('<Badge'), 'jsx stripped');
      assert.ok(result.includes('item'), 'content kept');
    });

    test('collapses multi-space runs outside backticks (same as paragraph)', () => {
      const b = itemBlock('- run  npm  install  now');
      const result = transform(b);
      assert.ok(!result.includes('  '), `double spaces must be collapsed; got: ${result}`);
      assert.ok(result.includes('run npm install now'), `content kept; got: ${result}`);
    });

    test('does not collapse spaces inside backtick spans', () => {
      const b = itemBlock('- run `npm   install` now');
      const result = transform(b);
      assert.ok(result.includes('`npm   install`'), `spaces inside backticks preserved; got: ${result}`);
    });

    test('bold **(a)** label in bullet-item opener preserved', () => {
      const b = itemBlock('- **(a)** Adjust foreign keys to use the new column.');
      const result = transform(b);
      assert.ok(result.includes('**(a)**'), '**(a)** bold label must survive normalizeListItem');
      assert.ok(result.includes('Adjust foreign keys'), 'content kept');
    });
  });

  describe('bullet-item', () => {
    test('preserves opener text', () => {
      const b = itemBlock('- item one');
      assert.ok(transform(b).includes('item one'));
    });

    test('nested bullet item in parts is transformed', () => {
      const b = itemBlock('- item one\n  - nested');
      const result = transform(b);
      assert.ok(result.includes('item one'));
      assert.ok(result.includes('nested'));
    });

    test('<Config> in bullet opener stripped to inner text (BUG-3)', () => {
      const b = itemBlock('- Java: <Config java keyOnly>cds.sql.hana.search.fuzzinessThreshold = 0.8</Config>');
      const result = transform(b);
      assert.ok(result.includes('cds.sql.hana.search.fuzzinessThreshold = 0.8'), 'inner text kept');
      assert.ok(!result.includes('<Config'), 'Config tag stripped');
    });

    test('<Since/> self-closing in bullet opener stripped (BUG-3)', () => {
      const b = itemBlock('- Available <Since package="@sap/cds" version="v10" /> since v10.');
      const result = transform(b);
      assert.ok(!result.includes('<Since'), 'Since tag stripped');
      assert.ok(result.includes('Available'), 'surrounding text kept');
      assert.ok(result.includes('since v10'), 'trailing text kept');
    });
  });

  describe('md-table', () => {
    test('preserves column relationships', () => {
      const text = '| col1 | col2 |\n|------|------|\n| a | b |';
      const b = block('md-table', text);
      const result = transform(b);
      assert.ok(result.includes('col1'));
      assert.ok(result.includes('col2'));
      assert.ok(result.includes('| a |'));
    });

    test('compacts multi-space padding in cells', () => {
      const b = block('md-table', '|   value   |   other   |\n|-----------|-----------|');
      const result = transform(b);
      assert.ok(!result.includes('  '), 'no double spaces');
    });

    test('collapses repeated dashes in separator row', () => {
      const b = block('md-table', '| a | b |\n|------|------|');
      const result = transform(b);
      assert.ok(result.includes('|-|') || result.match(/\|-+\|/), 'separator compacted');
      assert.ok(!result.includes('------'), 'no long dash run');
    });

    test('collapses multi-space runs in cell text outside backticks', () => {
      const b = block('md-table', '| run  npm  install | `keep  spaces` |\n|---|---|');
      const result = transform(b);
      // Outside-backtick cell content must have no double spaces
      const firstRow = result.split('\n')[0];
      const outsideBackticks = firstRow.replace(/`[^`]*`/g, '``');
      // Split on | to get individual cell strings, check each for double spaces
      const cells = outsideBackticks.split('|').map(c => c.trim());
      assert.ok(cells.every(c => !/ {2,}/.test(c)),
        `double spaces outside backticks must collapse; got: ${firstRow}`);
      assert.ok(result.includes('`keep  spaces`'), 'spaces inside backticks preserved');
    });

    test('idempotent', () => {
      const text = '| col1 | col2 |\n|------|------|\n| a | b |';
      const b1 = block('md-table', text);
      const first = transform(b1);
      const b2 = block('md-table', first);
      assert.equal(transform(b2), first);
    });

    test('strips {.class} markers from cells (BUG-4)', () => {
      const text = '| `hana` | [Learn more](/docs/hana#cfg){.learn-more} |\n|--------|------|';
      const b = block('md-table', text);
      const result = transform(b, '> Source: /docs/guides/deploy/build#build-task-types');
      assert.ok(!result.includes('{.learn-more}'), '{.learn-more} stripped from table cell');
      assert.ok(result.includes('Learn more'), 'link text preserved');
    });

    test('decodes feature-table status icons to readable labels', () => {
      const text = `| Messaging Broker                                       | Support |         Cause          |
                    | ------------------------------------------------------ | :-----: | :--------------------: |
                    | [File Base Messaging](#local-testing)                  |  <Na/>  |                        |
                    | [Event Mesh](#configuring-sap-event-mesh-support)      |  <X/>   | removed from the queue |
                    | [Message Queuing](#configuring-sap-event-mesh-support) |  <X/>   | removed from the queue |
                    | [Redis PubSub](#configuring-redis-pubsub-support-beta) | <Beta/> |                        |`;
      const b = block('md-table', text);
      const result = transform(b, '> Source: /docs/guides/deploy/build#build-task-types');
      assert.ok(!result.includes('<X/>'), '<X/> decoded, not left as raw tag');
      assert.ok(!result.includes('<Na/>'), '<Na/> decoded, not left as raw tag');
      assert.ok(!result.includes('<Beta/>'), '<Beta/> decoded, not left as raw tag');
      assert.ok(result.includes('Yes'), '<X/> decoded to "Yes"');
      assert.ok(result.includes('N/A'), '<Na/> decoded to "N/A"');
      assert.ok(result.includes('Beta'), '<Beta/> decoded to "Beta"');
    });

    test('decodes <D/> and <Y/> status icons', () => {
      const text = '| Feature | Node.js | Java |\n|---------|---------|------|\n| `$search` | <X/> | <Na/> |\n| `$compute` | <X/> | <D/> |\n| experimental | <Y/> | <Na/> |';
      const b = block('md-table', text);
      const result = transform(b);
      assert.ok(!result.includes('<D/>'), '<D/> decoded');
      assert.ok(!result.includes('<Y/>'), '<Y/> decoded');
      assert.ok(result.includes('Deprecated'), '<D/> decoded to "Deprecated"');
      const rows = result.split('\n').filter(l => l.trim().startsWith('|') && !l.trim().match(/^\|\s*[-:]+\s*\|/));
      assert.ok(rows.every(r => r.replace(/\|/g, '').trim().length > 0), 'no empty-cell rows');
    });

    test('decodes mixed <X/><sup><Beta/></sup> cell content', () => {
      const text = '| Method | Status |\n|--------|--------|\n| `cds.serve` | <X/><sup><Beta/></sup> |';
      const b = block('md-table', text);
      const result = transform(b);
      assert.ok(!result.includes('<X/>'), '<X/> decoded in mixed cell');
      assert.ok(!result.includes('<Beta/>'), '<Beta/> decoded in mixed cell');
      assert.ok(result.includes('Yes'), 'Yes present');
      assert.ok(result.includes('Beta'), 'Beta present');
    });

    test('<O/> in md-table cell: decoded', () => {
      const text = '| Feature | Node.js | Java |\n|---------|---------|------|\n| draft | <X/> | <O/> |';
      const b = block('md-table', text);
      const result = transform(b);
      assert.ok(!result.includes('<O/>'), '<O/> must not appear as raw tag in output');
      assert.ok(result.includes('no'), 'no must appear in output');
    });

    test('&emsp; decoded to "> " separator preserving hierarchy in table cell', () => {
      const text = '| `CountRestrictions`<br />&emsp;`/Countable` | EntitySet |\n|---|---|';
      const result = transform(block('md-table', text));
      assert.ok(result.includes('CountRestrictions'), 'parent term kept');
      assert.ok(result.includes('/Countable'), 'child term kept');
      assert.ok(result.includes('> '), '&emsp; decoded to "> " hierarchy marker');
      assert.ok(!result.includes('&emsp;'), 'no raw &emsp; entity');
    });

    test('double &emsp;&emsp; encodes two-level nesting as "> > "', () => {
      const text = '| &emsp;&emsp;`/Deeper` | EntitySet |\n|---|---|';
      const result = transform(block('md-table', text));
      assert.ok(result.includes('> > '), 'double emsp decoded to "> > "');
      assert.ok(!result.includes('&emsp;'), 'no raw &emsp;');
    });
  });

  describe('html-table (convertTableRows)', () => {
    test('converts <tr><td> row to pipe-separated markdown', () => {
      const b = block('html-table', '<table><tr><td>a</td><td>b</td></tr></table>');
      const result = transform(b);
      assert.ok(result.includes('| a | b |'), result);
    });

    test('drops row where all cells strip to empty', () => {
      const b = block('html-table', '<table><tr><td>  </td><td></td></tr><tr><td>real</td></tr></table>');
      const result = transform(b);
      assert.ok(!result.includes('|  |'), 'empty row dropped');
      assert.ok(result.includes('real'), 'non-empty row kept');
    });

    test('<li> items inside <td> joined with " / "', () => {
      const b = block('html-table', '<table><tr><td><ul><li>one</li><li>two</li></ul></td></tr></table>');
      const result = transform(b);
      assert.ok(result.includes('one / two'), result);
    });
  });

  describe('html-table', () => {
    test('strips table wrapper tags, keeps cell content', () => {
      const text = '<table>\n  <tr><td>foo</td><td>bar</td></tr>\n</table>';
      const b = block('html-table', text);
      const result = transform(b);
      assert.ok(result.includes('foo'), 'cell content kept');
      assert.ok(result.includes('bar'), 'cell content kept');
      assert.ok(!result.includes('<table>'), 'table tag stripped');
      assert.ok(!result.includes('<td>'), 'td tag stripped');
    });

    test('converts <a href> to markdown link', () => {
      const text = '<table><tr><td><a href="/docs/guide">Guide</a></td></tr></table>';
      const b = block('html-table', text);
      const result = transform(b);
      assert.ok(result.includes('Guide (/docs/guide)'), result);
    });

    test('<a href> with icon-only inner content emits the URL (not silently dropped)', () => {
      // Icon-only link: inner strips to empty after STRIP_TAGS. URL must survive as bare path.
      const text = '<table><tr><td><a href="/docs/guide"><img src="icon.svg"/></a></td></tr></table>';
      const b = block('html-table', text);
      const result = transform(b);
      assert.ok(result.includes('/docs/guide'), `URL must survive icon-only link; got: ${result}`);
    });

    test('resolves relative href against source', () => {
      const text = '<table><tr><td><a href="../plugins/">Plugins</a></td></tr></table>';
      const b = block('html-table', text);
      const result = transform(b, '> Source: /docs/authentication/oauth');
      assert.ok(result.includes('Plugins (/docs/plugins'), result);
    });

    test('strips thead/tbody/tr wrapper tags', () => {
      const text = '<table>\n  <thead><tr><th>Col</th></tr></thead>\n  <tbody><tr><td>val</td></tr></tbody>\n</table>';
      const b = block('html-table', text);
      const result = transform(b);
      assert.ok(result.includes('Col'), 'header kept');
      assert.ok(result.includes('val'), 'cell kept');
      assert.ok(!result.includes('<thead>'), 'thead stripped');
      assert.ok(!result.includes('<tbody>'), 'tbody stripped');
    });

    test('decodes HTML entities', () => {
      const text = '<table><tr><td>Get&nbsp;Started</td><td>price &gt; 0</td></tr></table>';
      const b = block('html-table', text);
      const result = transform(b);
      assert.ok(result.includes('Get Started'), 'nbsp decoded');
      assert.ok(result.includes('price > 0'), 'gt decoded');
    });

    test('whitespace-only lines removed after tag stripping', () => {
      const text = '<table>\n   <tr>\n      <td>content</td>\n   </tr>\n</table>';
      const b = block('html-table', text);
      const result = transform(b);
      assert.ok(!result.split('\n').some(l => l.trim() === '' ? false : l !== l.trim() && l.trim() === 'content' ? false : /^\s+$/.test(l)), 'no whitespace-only lines');
      assert.ok(result.includes('content'));
    });

    test('leading/trailing whitespace trimmed per line', () => {
      const text = '<table><tr><td>   spaced   </td></tr></table>';
      const b = block('html-table', text);
      const result = transform(b);
      assert.ok(result.includes('spaced'), 'content kept');
      assert.ok(!result.includes('   spaced'), 'leading spaces stripped');
    });

    test('preserves column relationships with | separators', () => {
      const text = `<table>
  <thead><tr><th>Property</th><th>Type</th><th>Description</th></tr></thead>
  <tbody>
    <tr><td>timeout</td><td>number</td><td>Max wait in ms</td></tr>
    <tr><td>retries</td><td>number</td><td>Number of retries</td></tr>
  </tbody>
</table>`;
      const b = block('html-table', text);
      const result = transform(b);
      const lines = result.split('\n');
      assert.ok(lines.some(l => l.includes('| Property | Type | Description |')), 'header row with separators');
      assert.ok(lines.some(l => l.includes('| timeout | number | Max wait in ms |')), 'data row with separators');
    });

    test('real-world: multi-row table with nested lists, anchors, entities, br', () => {
      const text = `<table>
   <thead>
      <tr>
         <th>Section</th> <th>Description</th>
      </tr>
   </thead>
   <tbody>
      <tr>
         <td><ul>
            <li><a href="./index"> Get&nbsp;Started </a> </li>
            <li> <a href="../guides/"> Develop </a> </li>
            <li> <a href="../guides/deploy/"> Deploy </a> </li>
         </ul></td>
         <td><ul>
            Guides that walk you through the most common tasks
            in CAP-based development and deployment.
         </ul></td>
      </tr>
      <tr>
         <td><ul>
            <li><a href="../cds/index"> CDS </a> </li>
            <li> <a href="../node.js/index"> Node.js </a> </li>
            <li> <a href="../java/index"> Java </a> </li>
            <li> <a href="../tools/index"> Tools </a> </li>
         </ul></td>
         <td><ul>
            Reference documentation for these respective areas.
         </ul></td>
      </tr>
      <tr>
         <td><ul>
            <li><a href="../plugins/"> Plugins </a> </li>
            <li><a href="../releases/"> Releases </a> </li>
            <li><a href="../resources/">Resources</a></li>
         </ul></td>
         <td><ul>
            Curated list of plugins for CAP. <br/>
            Release notes and release schedule. <br/>
            About support channels, community, ...
         </ul></td>
      </tr>
   </tbody>
</table>`;
      const b = block('html-table', text);
      const result = transform(b, '> Source: /docs/');
      const lines = result.split('\n');
      assert.ok(lines.some(l => l.includes('| Section |') && l.includes('Description')), 'header row');
      assert.ok(lines.some(l =>
        l.includes('Get Started (/docs/index)') &&
        l.includes('Develop (/docs/guides)') &&
        l.includes('Deploy (/docs/guides/deploy)')
      ), 'first data row — links on one line, resolved');
      assert.ok(lines.some(l =>
        l.includes('Plugins (/docs/plugins)') &&
        l.includes('Releases (/docs/releases)')
      ), 'second data row');
      assert.ok(lines.some(l =>
        l.includes('Get Started (/docs/index) / Develop (/docs/guides) / Deploy (/docs/guides/deploy)')
      ), 'list items slash-separated');
      assert.ok(!result.includes('&nbsp;'), 'no raw entities');
      assert.ok(!result.split('\n').some(l => /^\s+$/.test(l)), 'no whitespace-only lines');
      assert.ok(!result.includes('\n\n'), 'no blank lines between rows');
    });

    test('vue-template table: strips Vue directives from attrs, keeps th text and Config inner text', () => {
      const text = `<table>
        <thead>
          <tr>
            <th class="anchor"></th>
            <th class="prop">Property</th>
            <th class="java-type">Type</th>
            <th class="default">Default Value</th>
            <th class="descr">Description</th>
          </tr>
        </thead>
        <tr v-for="p in properties" :key="p.name" :id="p.anchor">
          <td class="anchor"><a :href="'#'+p.anchor" class="header-anchor"></a></td>
          <td class="prop"      :class="{ group: p.header }">
            <Config :label="p.nameHTML" java>{{p.name}}={{ Array.isArray(p.defaultValue) ? \`\${JSON.stringify(p.defaultValue)}\` : p.defaultValue }}</Config>
          </td>
          <td class="java-type" v-html="p.type" :title="p.typeFull"></td>
          <td class="default" v-html="p.defaultValueHTML"></td>
          <td class="descr"   v-html="p.description"></td>
        </tr>
      </table>`;
      const b = block('html-table', text);
      const result = transform(b);
      const lines = result.split('\n');
      assert.ok(
        lines.some(l => l === '| Property | Type | Default Value | Description |'),
        `header row: ${result}`
      );
      assert.ok(
        lines.some(l => l.startsWith('| {{p.name}}=') && l.endsWith(' |')),
        `data row keeps Config inner text: ${result}`
      );
      assert.ok(!result.includes('v-for'), 'v-for stripped');
      assert.ok(!result.includes('v-html'), 'v-html stripped');
      assert.ok(!result.includes('<Config'), '<Config tag stripped');
      assert.ok(!result.includes('<td'), '<td tag stripped');
    });

    test('<br/> and &emsp; hierarchy encoding flattened to plain text', () => {
      const b = block('html-table', '<table><tr><td>CountRestrictions<br />&emsp;/Countable</td></tr></table>');
      const result = transform(b);
      assert.ok(result.includes('CountRestrictions'), 'parent term kept');
      assert.ok(result.includes('/Countable'), 'child term kept');
      assert.ok(!result.includes('<br'), 'no raw <br> in output');
      assert.ok(!result.includes('&emsp;'), 'no raw &emsp; in output');
    });
  });

  describe('java-div / node-div', () => {
    test('java-div: prepends Java: label', () => {
      const b = itemBlock('<div class="impl java">\n\nsome java content\n\n</div>');
      const result = transform(b);
      assert.ok(result.startsWith('Java:'), 'label prepended');
      assert.ok(result.includes('some java content'), 'content kept');
      assert.ok(!result.includes('<div'), 'outer div tag stripped');
    });

    test('node-div: prepends Node.js: label', () => {
      const b = itemBlock('<div class="impl node">\n\nsome node content\n\n</div>');
      const result = transform(b);
      assert.ok(result.startsWith('Node.js:'), 'label prepended');
      assert.ok(result.includes('some node content'), 'content kept');
    });

    test('java-div: fence inside preserved verbatim', () => {
      const text = '<div class="impl java">\n\n```sh\nmvn spring-boot:run\n```\n\n</div>';
      const b = itemBlock(text);
      const result = transform(b);
      assert.ok(result.includes('mvn spring-boot:run'), 'fence content kept');
      assert.ok(result.includes('Java:'), 'label present');
    });

    test('java-div: relative links resolved', () => {
      const text = '<div class="impl java">\n\nSee [guide](../guides/)\n\n</div>';
      const b = itemBlock(text);
      const result = transform(b, '> Source: /docs/get-started/');
      assert.ok(result.includes('/docs/guides'), 'relative link resolved');
    });

    test('java-div: inner paragraph gets full transform — spaces collapsed, markers stripped', () => {
      const text = '<div class="impl java">\n\nText with   extra   spaces and {.tip} marker.\n\n</div>';
      const b = itemBlock(text);
      const result = transform(b);
      assert.ok(!result.includes('  '), 'multi-spaces collapsed');
      assert.ok(!result.includes('{.tip}'), 'class marker stripped');
      assert.ok(result.includes('Text with extra spaces and marker.'), 'content kept');
    });

    test('java-div: inner image markup stripped', () => {
      const text = '<div class="impl java">\n\n![diagram.png](./x.png)\n\n</div>';
      const b = itemBlock(text);
      const result = transform(b);
      assert.ok(!result.includes('!['), 'image syntax removed');
    });

    test('real-world: java-div → container(::: details) → fence: all content preserved', () => {
      const text = [
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
      const b = itemBlock(text);
      const result = transform(b);
      assert.ok(result.startsWith('Java:'), 'label prepended');
      assert.ok(result.includes('@RunWith(SpringRunner.class)'), 'fence content kept');
      assert.ok(result.includes('testViewer'), 'test method kept');
      assert.ok(result.includes('testUnauthorized'), 'test method kept');
      assert.ok(!result.includes('<div'), 'outer div stripped');
      assert.ok(result.includes(':::'), 'container delimiters stripped');
    });
  });

  describe('container', () => {
    test('container with two fences: both fences preserved', () => {
      const text = '::: code-group\n```shell [macOS]\nbrew install node\n```\n```shell [Windows]\nwinget install node\n```\n:::';
      const b = itemBlock(text);
      const result = transform(b);
      assert.ok(result.includes('brew install node'), 'macOS fence kept');
      assert.ok(result.includes('winget install node'), 'Windows fence kept');
      assert.ok(!result.includes('::: code-group'), 'container opener stripped');
      assert.ok(!result.includes(':::'), 'container closer stripped');
    });

    test('container with paragraph: paragraph transformed', () => {
      const text = '::: tip\nSome   spaced   text {.tip} here.\n:::';
      const b = itemBlock(text);
      const result = transform(b);
      assert.ok(result.includes('Some spaced text here.'), 'paragraph normalized');
      assert.ok(!result.includes('{.tip}'), 'class marker stripped');
    });

    test('strips {.class} markers from container opener line (BUG-4)', () => {
      const text = '::: details **Best Practice:**{.good} Use `@mandatory` instead.\nSome detail text.\n:::';
      const b = itemBlock(text);
      const result = transform(b);
      assert.ok(!result.includes('{.good}'), '{.good} stripped from container opener');
      assert.ok(result.includes('Best Practice'), 'opener text preserved');
    });

    test(':::opener title preserved as flat prose', () => {
      const admonitions = ['details', 'danger', 'info', 'tip', 'warning']
      for (const admon of admonitions) {
        const b = itemBlock(`:::${admon} Alternative manual setup\nSome inner text.\n:::`);
        const result = transform(b);
        assert.ok(result.includes(`:::${admon} Alternative manual setup`), 'opener title preserved');
      }
    });

    test(':::opener title preserved as flat prose', () => {
      const b = itemBlock(`::: code-group Alternative manual setup\nSome inner text.\n:::`);
      const result = transform(b);
      assert.ok(result === `Some inner text.`, 'opener title preserved');
    });
  });

  describe('cols-div', () => {
    test('cols-div: inner paragraphs transformed', () => {
      const text = '<div class="cols-2">\n<div>\nsome   content {.tip}\n</div>\n<div>\nother content\n</div>\n</div>';
      const b = itemBlock(text);
      const result = transform(b);
      assert.ok(result.includes('some content'), 'first col content kept');
      assert.ok(result.includes('other content'), 'second col content kept');
      assert.ok(!result.includes('{.tip}'), 'marker stripped');
      assert.ok(!result.includes('<div'), 'div tags stripped');
    });
  });

  describe('admonition', () => {
    test('preserves [!TYPE] marker line exactly', () => {
      const text = '> [!NOTE]\n> This is important.';
      const b = block('admonition', text);
      assert.equal(transform(b), text);
    });

    test('preserves [!WARNING] type', () => {
      const text = '> [!WARNING]\n> Be careful.';
      const b = block('admonition', text);
      assert.ok(transform(b).includes('[!WARNING]'));
    });

    test('<Since/> in admonition opener stripped (BUG-3)', () => {
      const b = {
        type: 'admonition',
        opener: '::: details Available for CAP Node.js <Since package="@sap/cds" version="v10" />',
        text: '::: details Available for CAP Node.js <Since package="@sap/cds" version="v10" />',
        parts: [{ type: 'paragraph', text: 'Some content.', supressCut: false }],
        supressCut: true,
      };
      const result = transform(b);
      assert.ok(!result.includes('<Since'), 'Since tag stripped from opener');
      assert.ok(result.includes('Available for CAP Node.js'), 'opener text kept');
    });

    test('<Beta/> in admonition opener stripped (BUG-3)', () => {
      const b = block('admonition', '> [!warning] Java only and <Beta/>');
      const result = transform(b);
      assert.ok(!result.includes('<Beta'), 'Beta tag stripped');
      assert.ok(result.includes('Java only'), 'text kept');
    });
  });

  describe('inline HTML stripping (BUG-6)', () => {
    test('<br> mid-line becomes a space in paragraph', () => {
      const b = block('paragraph', 'first line<br>second line');
      const result = transform(b);
      assert.ok(!result.includes('<br'), 'br tag stripped');
      assert.ok(result.includes('first line'), 'text before kept');
      assert.ok(result.includes('second line'), 'text after kept');
    });

    test('<br/> mid-line becomes a space in paragraph', () => {
      const b = block('paragraph', 'inbound<br/>outbound');
      const result = transform(b);
      assert.ok(!result.includes('<br'), 'br/ tag stripped');
      assert.ok(result.includes('inbound'), 'text before kept');
      assert.ok(result.includes('outbound'), 'text after kept');
    });

    test('<sup> footnote marker stripped, inner text kept', () => {
      const b = block('paragraph', 'See note<sup>(1)</sup> for details.');
      const result = transform(b);
      assert.ok(!result.includes('<sup>'), 'sup tag stripped');
      assert.ok(result.includes('(1)'), 'inner text kept');
    });

    test('<sup><Beta/></sup> in paragraph: nested JSX inside sup — Beta label kept', () => {
      const b = block('paragraph', 'Supported<sup><Beta/></sup> in preview.');
      const result = transform(b);
      assert.ok(!result.includes('<sup>'), 'sup tag stripped');
      assert.ok(!result.includes('<Beta/>'), 'Beta tag stripped');
      assert.ok(result.includes('(Beta)') || result.includes('Beta'), 'Beta label kept after nested JSX+sup strip');
    });

    test('<em> stripped, inner text kept', () => {
      const b = block('paragraph', 'Use <em>cds watch</em> to develop.');
      const result = transform(b);
      assert.ok(!result.includes('<em>'), 'em tag stripped');
      assert.ok(result.includes('cds watch'), 'inner text kept');
    });

    test('<strong> stripped, inner text kept', () => {
      const b = block('paragraph', '<strong>USAGE</strong>');
      const result = transform(b);
      assert.ok(!result.includes('<strong>'), 'strong tag stripped');
      assert.ok(result.includes('USAGE'), 'inner text kept');
    });

    test('<i> stripped, inner text kept in paragraph', () => {
      const b = block('paragraph', "CAP-level Service Integration (<i>'Calesi'</i>)");
      const result = transform(b);
      assert.ok(!result.includes('<i>'), 'i tag stripped');
      assert.ok(result.includes("'Calesi'"), 'inner text kept');
    });

    test('<br> stripped from md-table cell', () => {
      const b = block('md-table', '| col |\n|-----|\n| value<br>more |');
      const result = transform(b);
      assert.ok(!result.includes('<br'), 'br stripped from table cell');
      assert.ok(result.includes('value'), 'cell text kept');
    });

    test('<sup> stripped from md-table cell', () => {
      const b = block('md-table', '| feature | supported<sup>(1)</sup> |\n|-|-|');
      const result = transform(b);
      assert.ok(!result.includes('<sup>'), 'sup stripped from table');
      assert.ok(result.includes('(1)'), 'footnote marker kept');
    });

    test('<br> stripped from bullet-item opener', () => {
      const b = itemBlock('- inbound<br>outbound');
      const result = transform(b);
      assert.ok(!result.includes('<br'), 'br stripped from bullet');
      assert.ok(result.includes('inbound'), 'text kept');
    });

    test('<details><summary> unwrapped, inner content preserved', () => {
      const b = block('paragraph', '<details><summary>In more detail <code>cds deploy</code> does the following...</summary>\n\n* step one\n* step two\n\n</details>');
      const result = transform(b);
      assert.ok(!result.includes('<details>'), 'details tag stripped');
      assert.ok(!result.includes('<summary>'), 'summary tag stripped');
      assert.ok(result.includes('In more detail'), 'summary text kept');
      assert.ok(result.includes('cds deploy'), 'inner code text kept');
    });
  });

  describe('isEmpty flag', () => {
    test('sets isEmpty when result is empty', () => {
      const b = block('paragraph', '   \n\n   ');
      transform(b);
      assert.equal(b.isEmpty, true);
    });

    test('does not set isEmpty for non-empty result', () => {
      const b = block('paragraph', 'content here');
      transform(b);
      assert.ok(!b.isEmpty);
    });
  });

  describe('links', () => {
    test('preserves link label and url when no source given', () => {
      const text = 'See the [Attachments plugin](../plugins/index#attachments).';
      const b = block('paragraph', text);
      assert.ok(transform(b).includes('Attachments plugin (../plugins/index#attachments)'));
    });

    test('resolves relative link against source URL', () => {
      const b = block('paragraph', 'See [Attachments](../plugins/index#attachments).');
      const result = transform(b, '> Source: /docs/authentication/oauth');
      assert.ok(result.includes('Attachments (/docs/plugins/index#attachments)'), result);
    });

    test('absolute link passes through unchanged', () => {
      const b = block('paragraph', 'See [CAP](https://cap.cloud.sap/docs).');
      const result = transform(b, '> Source: /docs/authentication/oauth');
      assert.ok(result.includes('https://cap.cloud.sap/docs'));
    });

    test('fragment-only link resolved against source hash path', () => {
      const b = block('paragraph', 'See [section](#config).');
      const result = transform(b, '> Source: /docs/auth/oauth#setup');
      assert.ok(result.includes('/docs/auth/oauth#config'), result);
    });

    test('absolute path link passes through unchanged', () => {
      const b = block('paragraph', 'See [page](/docs/other).');
      const result = transform(b, '> Source: /docs/auth/oauth');
      assert.ok(result.includes('/docs/other'));
    });

    test('ref-style link definition resolved', () => {
      const text = '[label]: ../plugins/index';
      const b = block('paragraph', text);
      const result = transform(b, '> Source: /docs/auth/oauth');
      assert.ok(result.includes('/docs/plugins/index'), result);
    });
  });

  describe('image markup', () => {
    test('meaningful alt text kept as plain text', () => {
      const b = block('paragraph', '![Architecture overview](./arch.png)');
      assert.equal(transform(b), 'Architecture overview');
    });

    test('filename-style alt dropped entirely', () => {
      const b = block('paragraph', '![arch.png](./arch.png)');
      assert.equal(transform(b), '');
    });

    test('boilerplate alt dropped entirely', () => {
      const b = block('paragraph', '![This graphic is explained in the accompanying text](./x.png)');
      assert.equal(transform(b), '');
    });

    test('title attribute wins over shorter alt', () => {
      const b = block('paragraph', '![img](./x.png "Full descriptive title here")');
      assert.equal(transform(b), 'Full descriptive title here');
    });

    test('empty alt dropped, surrounding text preserved', () => {
      const b = block('paragraph', 'See below: ![](./x.png) for details.');
      const result = transform(b);
      assert.ok(!result.includes('![]'), 'empty image removed');
      assert.ok(result.includes('See below'), 'surrounding text kept');
    });

    test('image inside sentence — meaningful alt replaces image', () => {
      const b = block('paragraph', 'Use the ![save icon](./save.svg) button.');
      const result = transform(b);
      assert.ok(result.includes('save icon'), 'alt kept');
      assert.ok(!result.includes('!['), 'image syntax removed');
    });

    test('image with empty {} brace: brace stripped, alt text kept', () => {
      const b = block('paragraph', 'See ![Architecture overview](./arch.png) {} for details.');
      const result = transform(b);
      assert.ok(!result.includes('{}'), 'empty brace stripped');
      assert.ok(result.includes('Architecture overview'), 'alt text kept');
    });

    test('badge image-in-link: alt matching logo filename but used as link label is kept (real pattern from llms-full.txt)', () => {
      const text = '[![Node.js](/logos/nodejs.svg){}](https://github.com/cap-js/ai)\n[![Java](/logos/java.svg){}](https://github.com/cap-java/cds-ai)';
      const b = block('paragraph', text);
      const result = transform(b, '> Source: /docs/plugins/ai');
      assert.ok(result.includes('Node.js (https://github.com/cap-js/ai)'), `Node.js link must survive: ${result}`);
      assert.ok(result.includes('Java (https://github.com/cap-java/cds-ai)'), `Java link must survive: ${result}`);
      assert.ok(!result.includes('!['), 'image syntax must be stripped');
    });

    test('rich alt text on .drawio.svg diagram extracted verbatim', () => {
      const alt = 'CAP-level service integration with two scenarios: Local services where Consumer connects to Service via CQL, and Remote services where Consumer connects to Proxy via CQL';
      const b = block('paragraph', `![${alt}](../guides/integration/assets/remoting.drawio.svg)`);
      assert.equal(transform(b), alt);
    });

    test('empty alt on .drawio.svg is total content loss — isEmpty flagged', () => {
      const b = block('paragraph', '![](./assets/bookshop-service.drawio.svg)');
      const result = transform(b);
      assert.equal(result, '');
      assert.equal(b.isEmpty, true);
    });

    test('empty alt on .excalidraw.svg produces empty result', () => {
      const b = block('paragraph', '![](./assets/diagram.excalidraw.svg)');
      assert.equal(transform(b), '');
    });

    test('{.ignore-dark} suffix stripped, alt text survives', () => {
      const b = block('paragraph', '![Architecture overview](./arch.drawio.svg){.ignore-dark}');
      assert.equal(transform(b), 'Architecture overview');
    });

    test('{ } space-only brace suffix stripped, alt text survives', () => {
      const b = block('paragraph', '![Architecture overview](./arch.drawio.svg){ }');
      assert.equal(transform(b), 'Architecture overview');
    });

    test('rich alt + {.ignore-dark} on diagram: alt survives, suffix stripped', () => {
      const alt = 'Overview of the CAP architecture with Java and Node.js runtimes';
      const b = block('paragraph', `![${alt}](./overview.drawio.svg){.ignore-dark}`);
      assert.equal(transform(b), alt);
    });

    test('<iframe> inner description text should survive as context for embedding retrieval', () => {
      const b = block('paragraph', '<iframe src="https://example.com/demo">Watch this video about CAP setup</iframe>');
      const result = transform(b);
      assert.ok(result.includes('video (https://example.com/demo)'), 'URL survives as video (url)');
      assert.ok(result.includes('Watch this video about CAP setup'), 'description text must survive — currently dropped by convertMediaEmbeds');
    });
  });

  describe('idempotency', () => {
    test('paragraph idempotent', () => {
      const text = 'Some text   with   unnecessary  spacing.';
      const b1 = block('paragraph', text);
      const first = transform(b1);
      const b2 = block('paragraph', first);
      assert.equal(transform(b2), first);
    });

    test('admonition idempotent', () => {
      const text = '> [!NOTE]\n> Content here.';
      const b1 = block('admonition', text);
      const first = transform(b1);
      const b2 = block('admonition', first);
      assert.equal(transform(b2), first);
    });

    test('paragraph ending with a stripped image has no trailing newline', () => {
      const raw = "[![Node.js logo](/logos/nodejs.svg 'Link.'){}](https://github.com/cap-js/audit-logging#readme)\n![Java](/logos/java.svg){}";
      const b = block('paragraph', raw);
      const result = transform(b, '> Source: /docs/plugins/#audit-logging');
      assert.ok(
        !result.endsWith('\n'),
        `paragraph must not end with \\n after image strip; got: ${JSON.stringify(result)}`
      );
    });

    test('paragraph with only a stripped image produces empty result (isEmpty=true)', () => {
      const raw = '![arch.drawio](./arch.drawio)';
      const b = block('paragraph', raw);
      transform(b, '> Source: /docs/a#b');
      assert.ok(b.isEmpty, 'paragraph reduced to empty by image strip must set isEmpty=true');
    });

    test('paragraph with real text followed by stripped image: text preserved, no trailing whitespace', () => {
      const raw = 'Some prose here.\n\n![decorative](./diagram.drawio)';
      const b = block('paragraph', raw);
      const result = transform(b, '> Source: /docs/a#b');
      assert.ok(result.includes('Some prose here.'), 'prose must survive');
      assert.equal(result, result.trim(), `result must be fully trimmed; got: ${JSON.stringify(result)}`);
    });
  });

  describe('custom component tag stripping', () => {
    function para(text) { return { type: 'paragraph', text }; }

    test('<Config> paired tag: inner text kept', () => {
      const result = transform(para('Ports: <Config> cds.server.port = 4005 </Config> or env var.'));
      assert.equal(result, 'Ports: cds.server.port = 4005 or env var.');
    });

    test('<Config java> prepends Java: runtime prefix', () => {
      const result = transform(para('enable <Config java keyOnly>cds.sql.hana.search.fuzzy = true</Config> for fuzzy search'));
      assert.equal(result, 'enable Java: cds.sql.hana.search.fuzzy = true for fuzzy search');
    });

    test('<Config keyOnly> inline: inner text kept', () => {
      const result = transform(para('Node.js: <Config keyOnly>cds.query.limit.reliablePaging: true</Config>'));
      assert.equal(result, 'Node.js: cds.query.limit.reliablePaging: true');
    });

    test('<Tip> paired tag: prefixes "Tip:" to inner text', () => {
      assert.equal(transform(para('<Tip>use cds.serve</Tip>')), 'Tip: use cds.serve');
    });

    test('<Warning> paired tag: prefixes "Warning:" to inner text', () => {
      assert.equal(transform(para('<Warning>breaking change</Warning>')), 'Warning: breaking change');
    });

    test('<Danger> paired tag: prefixes "Danger:" to inner text', () => {
      assert.equal(transform(para('<Danger>data loss</Danger>')), 'Danger: data loss');
    });

    test('<CdsSrv link="..."> paired tag: inner text kept', () => {
      const result = transform(para('Use <CdsSrv link="services/ErrorStatus.html">ErrorStatus</CdsSrv> to handle errors.'));
      assert.equal(result, 'Use ErrorStatus to handle errors.');
    });

    test('<Cds4j link="..."> paired tag: inner text kept', () => {
      const result = transform(para('See <Cds4j link="ql/cqn/CqnLimit.html">CqnLimit</Cds4j> for details.'));
      assert.equal(result, 'See CqnLimit for details.');
    });

    test('<Since .../> self-closing: replaced with "Since <package> <version>" label', () => {
      const result = transform(para('Available <Since package="@sap/cds" version="v10" /> since version 10.'));
      assert.equal(result, 'Available (Since @sap/cds v10) since version 10.');
    });

    test('<Beta/> self-closing: replaced with "(Beta)" label', () => {
      const result = transform(para('This feature is <Beta/> and may change.'));
      assert.equal(result, 'This feature is (Beta) and may change.');
    });

    test('<Na/> self-closing: decoded to "N/A"', () => {
      const result = transform(para('<Na/> Not applicable.'));
      assert.equal(result, 'N/A Not applicable.');
    });

    test('multiple custom tags in one paragraph', () => {
      const result = transform(para(
        'Java: <Config java keyOnly>cds.query.limit.reliablePaging.enabled: true</Config>\n\n' +
        'Node.js: <Config keyOnly>cds.query.limit.reliablePaging: true</Config>'
      ));
      assert.equal(result, 'Java: Java: cds.query.limit.reliablePaging.enabled: true\n\nNode.js: cds.query.limit.reliablePaging: true');
    test('attribute-bearing <span> unwrapped (unwrapAttributedSpans)', () => {
      const result = transform(para('See <span class="highlight">important</span> note.'));
      assert.equal(result, 'See important note.');
    });

    test('attribute-bearing <div> unwrapped (unwrapAttributedSpans)', () => {
      const result = transform(para('<div id="x">content</div>'));
      assert.equal(result, 'content');
    });

    test('<span> without attributes not touched by unwrapAttributedSpans', () => {
      // plain <span> has no space after tag name so unwrapAttributedSpans skips it
      // (stripped later by stripInlineHtml or convertHtmlToMarkdown)
      const result = transform(para('plain text'));
      assert.equal(result, 'plain text');
    });
  });
    test('resolveLinks clamps parent traversal at /docs root', () => {
      const b = block('paragraph', '[x](../../../../etc.md)');
      const result = transform(b, '> Source: /docs/guides/foo.md');
      assert.match(result, /x \(\/docs\/etc\)/, `expected clamp at /docs; got: ${result}`);
    });

    test('resolveLinks leaves #/ SPA fragments unchanged', () => {
      const b = block('paragraph', '[x](#/route/thing)');
      const result = transform(b, '> Source: /docs/a/b.md');
      assert.match(result, /x \(#\/route\/thing\)/);
    });

    test('image title-in-URL longer than alt replaces the alt', () => {
      const b = block('paragraph', '![short](/x "much longer title text")');
      const result = transform(b, '> Source: /docs/a');
      assert.ok(result.includes('much longer title text'));
      assert.ok(!result.includes('short'));
    });

    test('unknown named entity is preserved verbatim', () => {
      const b = block('paragraph', 'foo &foobar; bar');
      const result = transform(b, '');
      assert.ok(result.includes('&foobar;'), `unknown entity must survive; got: ${result}`);
    });

    test('<iframe src="url"> in html-table becomes video (url)', () => {
      const b = block('html-table', '<table><tr><td><iframe src="https://example.com/v"></iframe></td></tr></table>');
      const result = transform(b, '');
      assert.ok(result.includes('video (https://example.com/v)'), `expected video (...); got: ${result}`);
    });

    test('<video src="url"> in html-table becomes video (url)', () => {
      const b = block('html-table', '<table><tr><td><video src="https://example.com/demo.mp4"></video></td></tr></table>');
      const result = transform(b, '');
      assert.ok(result.includes('video (https://example.com/demo.mp4)'), `expected video (...); got: ${result}`);
    });

    test('<tr> whose cells all strip to empty is dropped from html-table', () => {
      const b = block('html-table', [
        '<table>',
        '<tr><td>real</td></tr>',
        '<tr><td>   </td><td></td></tr>',
        '</table>',
      ].join('\n'));
      const result = transform(b, '');
      const rows = result.split('\n').filter(l => l.startsWith('|'));
      assert.equal(rows.length, 1, `expected one row; got: ${JSON.stringify(rows)}`);
      assert.ok(rows[0].includes('real'));
    });

    test('<td> containing <ul><li> items joins items with " / "', () => {
      const b = block('html-table', '<table><tr><td><ul><li>a</li><li>b</li><li>c</li></ul></td></tr></table>');
      const result = transform(b, '');
      assert.ok(result.includes('a / b / c'), `expected joined items; got: ${result}`);
    });

    test('container with opener and no closer emits opener + inner, no undefined tail', () => {
      const inner = { type: 'paragraph', text: 'hello', supressCut: false };
      const b = { type: 'container', opener: '::: tip', closer: null, parts: [inner], supressCut: true };
      const result = transform(b, '');
      assert.ok(!/undefined/.test(result), `no literal 'undefined'; got: ${result}`);
      assert.ok(result.startsWith('::: tip'));
      assert.ok(result.includes('hello'));
    });

    test('java-div with all-empty inner parts leaves text empty and marks isEmpty', () => {
      const emptyInner = { type: 'paragraph', text: '![filename.png](./x.png)', supressCut: false };
      const b = { type: 'java-div', opener: '<div class="impl java">', closer: '</div>', parts: [emptyInner], supressCut: false };
      const result = transform(b, '');
      assert.equal(result, '');
      assert.equal(b.isEmpty, true);
    });

    test('admonition whose inner parts all transform to empty does not emit bare "> " line', () => {
      const b = {
        type: 'admonition',
        opener: '> [!NOTE]',
        text: '> [!NOTE]\n> ![decorative](./x.drawio)',
        parts: [{ type: 'paragraph', text: '![decorative](./x.drawio)', supressCut: false }],
        supressCut: true,
      };
      const result = transform(b, '');
      assert.ok(!/^>\s*$/m.test(result), `no bare '> ' line; got: ${JSON.stringify(result)}`);
    });

    test('resolveLinks with source ending in / uses dir directly', () => {
      const b = block('paragraph', '[x](./sibling.md)');
      const result = transform(b, '> Source: /docs/guides/');
      assert.match(result, /\/docs\/guides\/sibling/, `got: ${result}`);
    });

    test('resolveLinks throws when URL is a bracket-wrapped reference-style label (BUG-2)', () => {
      // Source doc bug: [`Null`]([annotation expression](#null-value))
      // The URL "[annotation expression](#null-value)" starts with '[' — must throw, not silently mangle.
      const b = block('paragraph', 'see [`Null`]([annotation expression](#null-value)) for details.');
      assert.throws(
        () => transform(b, '> Source: /docs/guides/protocols/odata#expression-translation'),
        /resolveRelativeLinks: bracket in URL/,
        'expected throw on bracket-in-URL'
      );
    });

    test('<Config java> runtime prefix added to inner text', () => {
      const b = block('paragraph', '<Config java keyOnly>cds.sql.hana.search.fuzzy = true</Config>');
      assert.equal(transform(b), 'Java: cds.sql.hana.search.fuzzy = true');
    });

    test('<Since> package attribute included in label when version present', () => {
      // Inline (non-stub) usage: package and version both emitted as "(Since <pkg> <ver>)"
      const b = block('paragraph', 'Available <Since version="v3.8" package="CAP Java"/> now.');
      assert.equal(transform(b), 'Available (Since CAP Java v3.8) now.');
    });

    test('two adjacent <Since> tags with different packages each keep their package label', () => {
      const b = block('paragraph', '<Since version="v3.8" package="CAP Java"/> and <Since version="v9.1" package="CAP Node.js"/>');
      assert.equal(transform(b), '(Since CAP Java v3.8) and (Since CAP Node.js v9.1)');
    });

    test('unknown PascalCase self-closing tag stripped, surrounding text kept', () => {
      const b = block('paragraph', '<IndexList :pages="pages" /> See also the guide.');
      assert.equal(transform(b), 'See also the guide.');
    });

    test('paragraph of only unknown PascalCase self-closing tag produces empty result', () => {
      const b = block('paragraph', '<IndexList :pages="pages" />');
      const result = transform(b);
      // stub line dropped by removeHtmlStubLines → empty → isEmpty flagged
      assert.equal(result, '');
      assert.equal(b.isEmpty, true);
    });

    test('<Alpha/> self-closing: replaced with "(Alpha)" label', () => {
      const result = transform(block('paragraph', 'This feature is <Alpha/> and experimental.'));
      assert.ok(result.includes('(Alpha)'), '(Alpha) label present');
      assert.ok(!result.includes('<Alpha'), 'raw tag gone');
    });

    test('<Gamma/> self-closing: replaced with "(Gamma)" label', () => {
      const result = transform(block('paragraph', 'Feature tier <Gamma/>.'));
      assert.ok(result.includes('(Gamma)'), '(Gamma) label present');
      assert.ok(!result.includes('<Gamma'), 'raw tag gone');
    });

    test('<Internal/> self-closing: replaced with "(SAP specific)" label', () => {
      const result = transform(block('paragraph', 'This API is <Internal/> only.'));
      assert.ok(result.includes('(SAP specific)'), '(SAP specific) label present');
      assert.ok(!result.includes('<Internal'), 'raw tag gone');
    });

    test('<ImplVariantsHint/> unknown self-closing: not leaked as raw tag', () => {
      const result = transform(block('paragraph', 'See <ImplVariantsHint/> for details.'));
      assert.ok(!result.includes('<ImplVariantsHint'), '<ImplVariantsHint/> must not appear as raw tag');
    });

    test('<X/><sup><Beta/></sup> in paragraph: both decoded, not leaked as raw tags', () => {
      const result = transform(block('paragraph', 'Supported <X/><sup><Beta/></sup> in preview.'));
      assert.ok(!result.includes('<X/>'), '<X/> must not be raw in paragraph');
      assert.ok(!result.includes('<Beta/>'), '<Beta/> must not be raw in paragraph');
      assert.ok(result.includes('Yes'), '<X/> decoded to Yes');
    });
  });

  describe('preservation — must not strip', () => {
    // Group 1: Fence content

    test('F1: [!code highlight] inside fence preserved verbatim', () => {
      const text = '```cds\nreviewTravel @from: #Open @to: #InReview; // [!code highlight]\n```';
      const b = block('fence', text);
      assert.ok(transform(b).includes('[!code highlight]'), '[!code highlight] must survive fence transform');
    });

    test('F2: [filename] label in fence opener preserved', () => {
      const text = '```js [app.js]\nconst x = 1\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.startsWith('```js [app.js]'), `opener with [filename] must be unchanged; got: ${result}`);
    });

    test('F3: entity-containing label in fence opener preserved', () => {
      const text = '```sql [=>&nbsp; Compiled SQL query]\nSELECT * FROM Books\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.startsWith('```sql [=>&nbsp; Compiled SQL query]'), `opener with entity label must be unchanged; got: ${result}`);
    });

    test('F4: empty lines inside fence preserved', () => {
      const text = '```js\nconst a = 1\n\nconst b = 2\n```';
      const b = block('fence', text);
      assert.ok(transform(b).includes('\n\n'), 'blank line inside fence must survive');
    });

    test('F5: indentation inside fence preserved', () => {
      const text = '```java\npublic class Foo {\n  void bar() {\n    return;\n  }\n}\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.includes('  void bar()'), 'two-space indent must survive');
      assert.ok(result.includes('    return;'), 'four-space indent must survive');
    });

    test('F6: multiline template literal inside fence preserved', () => {
      const text = '```js\nconst q = `SELECT ${x}\nFROM y`\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.includes('SELECT ${x}'), 'first line of template literal must survive');
      assert.ok(result.includes('FROM y'), 'second line of template literal must survive');
    });

    test('F7: @ CDS annotation inside fence preserved', () => {
      const text = '```cds\n@mandatory\nelement field : String;\n```';
      const b = block('fence', text);
      assert.ok(transform(b).includes('@mandatory'), '@mandatory annotation must survive fence transform');
    });

    test('F8: $self / $user dollar-prefix identifiers inside fence preserved', () => {
      const text = '```cds\nbooks : Association to many Books on books.author = $self;\n```';
      const b = block('fence', text);
      assert.ok(transform(b).includes('$self'), '$self must survive fence transform');
    });

    // Group 2: Prose / paragraph

    test('P1: || pipe operator in prose not treated as table', () => {
      const b = block('paragraph', 'Use A || B for string concatenation.');
      assert.ok(transform(b).includes('||'), '|| must survive in prose');
    });

    test('P2: => arrow in prose preserved', () => {
      const b = block('paragraph', 'cds <src>  =>  cds compile <src>');
      assert.ok(transform(b).includes('=>'), '=> must survive in prose');
    });

    test('P3: → Unicode arrow in prose preserved', () => {
      const b = block('paragraph', 'Passive data is immutable → allows parallelization.');
      assert.ok(transform(b).includes('→'), '→ Unicode arrow must survive');
    });

    test('P4: --- horizontal rule line inside paragraph preserved', () => {
      const b = block('paragraph', 'before\n\n---\n\nafter');
      assert.ok(transform(b).includes('---'), '--- separator line must survive');
    });

    test('P5: > blockquote lines in paragraph not mangled', () => {
      const b = block('paragraph', '> This is a quote\n> spanning two lines');
      const result = transform(b);
      assert.ok(result.includes('> This is a quote'), '> prefix on first line must survive');
      assert.ok(result.includes('> spanning'), '> prefix on second line must survive');
    });

    test('P6: double-backtick spans preserved', () => {
      const b = block('paragraph', 'Use ``code with `backtick` inside`` as raw span.');
      assert.ok(transform(b).includes('``code with `backtick` inside``'), 'double-backtick span must survive');
    });

    test('P7: OData $skip / $top / $expand query params in prose preserved', () => {
      const b = block('paragraph', 'Try GET /Books?$skip=10&$top=5&$expand=author.');
      const result = transform(b);
      assert.ok(result.includes('$skip=10'), '$skip must survive');
      assert.ok(result.includes('$top=5'), '$top must survive');
      assert.ok(result.includes('$expand=author'), '$expand must survive');
    });

    // Group 3: md-table preservation

    test('T1: &check; decoded to ✓ in md-table cell', () => {
      const b = block('md-table', '| Feature | Supported |\n|-|-|\n| CRUD | &check; |');
      assert.ok(transform(b).includes('✓'), '&check; must decode to ✓ in table cell');
    });

    test('T2: &rarr; decoded to → in md-table cell', () => {
      const b = block('md-table', '| From | To |\n|-|-|\n| A | B &rarr; C |');
      assert.ok(transform(b).includes('→'), '&rarr; must decode to → in table cell');
    });

    test('T3: &nbsp; decoded (no raw entity) in md-table cell', () => {
      const b = block('md-table', '| Section |\n|-|\n| Get&nbsp;Started |');
      const result = transform(b);
      assert.ok(!result.includes('&nbsp;'), '&nbsp; must not appear raw in output');
      assert.ok(result.includes('Get'), 'cell text must survive');
    });

    test('T4: alignment colons in separator row preserved', () => {
      const b = block('md-table', '| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |');
      const result = transform(b);
      assert.ok(result.includes(':'), 'alignment colons must survive in separator row');
    });

    test('T5: pipe inside backtick span in md-table cell preserved', () => {
      const b = block('md-table', '| Handler | Syntax |\n|-|-|\n| register | `<hook:on|before|after>` |');
      const result = transform(b);
      assert.ok(result.includes('`<hook:on|before|after>`'), 'pipe inside backtick in table cell must survive');
    });

    test('T6: {.class} inside backtick in md-table cell not stripped', () => {
      const b = block('md-table', '| Example | Usage |\n|-|-|\n| `{.class}` | add to element |');
      const result = transform(b);
      assert.ok(result.includes('`{.class}`'), '{.class} inside backtick in table cell must survive');
    });

    // Group 4: Admonition preservation

    test('A1: ordered list items inside admonition preserved', () => {
      const text = '> [!NOTE]\n> 1. First step\n> 2. Second step\n> 3. Third step';
      const b = block('admonition', text);
      const result = transform(b);
      assert.ok(result.includes('1. First step'), '1. list item must survive in admonition');
      assert.ok(result.includes('2. Second step'), '2. list item must survive');
      assert.ok(result.includes('3. Third step'), '3. list item must survive');
    });

    test('A2: bold and italic inside admonition body preserved', () => {
      const text = '> [!TIP]\n> Use **bold** for emphasis and *italic* for terms.';
      const b = block('admonition', text);
      const result = transform(b);
      assert.ok(result.includes('**bold**'), '**bold** must survive in admonition body');
      assert.ok(result.includes('*italic*'), '*italic* must survive in admonition body');
    });

    test('A3: inline code inside admonition body preserved', () => {
      const text = '> [!NOTE]\n> Run `cds watch` to start dev server.';
      const b = block('admonition', text);
      assert.ok(transform(b).includes('`cds watch`'), 'backtick span must survive in admonition');
    });

    // Group 5: Container preservation

    test('C1: :::: code-group (4-colon) container — inner fences preserved', () => {
      const text = ':::: code-group\n```shell [macOS]\nbrew install node\n```\n```shell [Windows]\nwinget install node\n```\n::::';
      const b = itemBlock(text);
      const result = transform(b);
      assert.ok(result.includes('brew install node'), 'macOS fence content must survive 4-colon container');
      assert.ok(result.includes('winget install node'), 'Windows fence content must survive 4-colon container');
    });

    test('C2: container opener prose text preserved after class-marker strip', () => {
      const text = '::: tip **Best Practice:** Use open version ranges.\nSome detail.\n:::';
      const b = itemBlock(text);
      const result = transform(b);
      assert.ok(result.includes('Best Practice'), 'opener prose must survive container transform');
      assert.ok(result.includes('**Best Practice:**'), 'bold in opener must survive');
    });

    // Group 6: Inline code backtick protection

    test('I1: pipe inside backtick in paragraph not mangled', () => {
      const b = block('paragraph', 'Use `<hook:on|before|after>` as the handler signature.');
      assert.ok(transform(b).includes('`<hook:on|before|after>`'), 'pipe inside backtick must survive in paragraph');
    });

    test('I2: => inside backtick preserved', () => {
      const b = block('paragraph', 'Arrow function `x => x + 1` is shorthand.');
      assert.ok(transform(b).includes('`x => x + 1`'), '=> inside backtick must survive');
    });

    test('I3: {.class} inside backtick in paragraph not stripped', () => {
      const b = block('paragraph', 'Add `{.class}` to the markdown element.');
      assert.ok(transform(b).includes('`{.class}`'), '{.class} inside backtick in paragraph must not be stripped');
    });

    test('P8: Vue template binding {{ versions.X }} preserved verbatim', () => {
      const b = block('paragraph', 'Requires CAP Java {{ versions.java_services }} or later.');
      assert.equal(transform(b), 'Requires CAP Java {{ versions.java_services }} or later.');
    });

    test('P9: inline PascalCase XML self-closer (e.g. <Annotation/>) stripped by stripJsxComponents — content loss documented', () => {
      // <Annotation .../> is a PascalCase self-closer with no JSX_BADGE_LABELS entry → resolves to ''
      // This documents the known loss so a regression (e.g. accidentally emitting raw tag) is caught.
      const b = block('paragraph', 'See <Annotation Term="Org.OData.Core.V1.Description" String="x"/> for details.');
      assert.equal(transform(b), 'See for details.');
    });

    // Group 7: Fence language tags (Section 3 risk findings)

    test('F9: ```cds language tag in fence opener preserved verbatim', () => {
      const text = '```cds\nentity Books { title : String; }\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.startsWith('```cds'), '```cds language tag must survive fence transform');
    });

    test('F10: ```[macOS] platform-only fence label preserved verbatim', () => {
      const text = '```[macOS]\nbrew install node\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.startsWith('```[macOS]'), '```[macOS] platform label must survive; got: ' + result);
    });

    test('F11: ```[Windows] platform-only fence label preserved verbatim', () => {
      const text = '```[Windows]\nwinget install node\n```';
      const b = block('fence', text);
      const result = transform(b);
      assert.ok(result.startsWith('```[Windows]'), '```[Windows] platform label must survive; got: ' + result);
    });

    // Group 8: Unicode characters (Section 6 risk findings)

    test('U1: literal en-dash (–) in prose preserved unchanged', () => {
      const b = block('paragraph', 'Dependencies – with a leading caret – stay flexible.');
      assert.ok(transform(b).includes('–'), 'en-dash U+2013 must survive normalizeProse');
    });

    test('U2: literal em-dash (—) in prose preserved unchanged', () => {
      const b = block('paragraph', 'CAP — Cloud Application Programming Model — is opinionated.');
      assert.ok(transform(b).includes('—'), 'em-dash U+2014 must survive normalizeProse');
    });

    test('U3: &ndash; entity decoded to en-dash –, not hyphen -', () => {
      const b = block('paragraph', 'Range: 1 &ndash; 10');
      const result = transform(b);
      assert.ok(result.includes('–'), '&ndash; must decode to – (U+2013), not be stripped or left as entity');
      assert.ok(!result.includes('&ndash;'), 'raw &ndash; entity must not remain');
    });

    test('U4: &mdash; entity decoded to em-dash —', () => {
      const b = block('paragraph', 'Note &mdash; this is important.');
      const result = transform(b);
      assert.ok(result.includes('—'), '&mdash; must decode to — (U+2014)');
      assert.ok(!result.includes('&mdash;'), 'raw &mdash; entity must not remain');
    });
  });
});
