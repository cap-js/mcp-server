import { it, describe } from 'node:test'
import assert from 'node:assert'
import {
  transformBlock as transform,
  transformSection
} from '../../../lib/markdownEmbeddings/chunker/stages/05-transform.js'
import { parseBlocks } from '../../../lib/markdownEmbeddings/chunker/stages/04-parse-blocks.js'

function block(type, text) {
  return { type, text, supressCut: false }
}

function itemBlock(text) {
  return parseBlocks(text)[0]
}

describe('transform', () => {
  describe('when normalizing prose blocks (paragraph, heading, redirect)', () => {
    it('should apply full pipeline: normalize, strip markers, strip jsx, strip images, decode, collapse spaces, resolve links', () => {
      const b = block('paragraph', 'See  <Tip>note</Tip>  &amp;  [guide](../guide.md)')
      const result = transform(b, '> Source: /docs/java/ref.md')
      assert.ok(!result.includes('<Tip>'), 'jsx stripped')
      assert.ok(result.includes('Tip: note'), 'Tip content prefixed')
      assert.ok(result.includes('&'), 'entity decoded')
      assert.ok(result.includes('guide (/docs/guide)'), 'link resolved: ' + result)
      assert.ok(!result.includes('  '), 'double spaces collapsed')
    })

    it('should apply the same prose pipeline to heading and redirect blocks', () => {
      const bh = block('heading', '## Title {.class} ![x](y.png)')
      const br = block('redirect', 'Redirect {.note} text')
      assert.strictEqual(transform(bh), '## Title')
      assert.strictEqual(transform(br), 'Redirect text')
    })
  })

  describe('when transforming a paragraph', () => {
    it('should collapse multi-space runs', () => {
      const b = block('paragraph', 'Some text   with   unnecessary spacing.')
      assert.strictEqual(transform(b), 'Some text with unnecessary spacing.')
    })

    it('should preserve wording exactly', () => {
      const input = 'Do not rewrite or paraphrase this content.'
      const b = block('paragraph', input)
      assert.strictEqual(transform(b), input)
    })

    it('should not collapse spaces inside backtick spans', () => {
      const b = block('paragraph', 'run `npm   install` now')
      assert.strictEqual(transform(b), 'run `npm   install` now')
    })

    it('should preserve (deprecated) inline text unchanged', () => {
      const b = block('paragraph', 'Use cds.serve (deprecated) instead.')
      assert.ok(
        transform(b).includes('(deprecated)'),
        '(deprecated) parenthetical must survive normalizeProse'
      )
    })

    it('should remove <Config> tags and keep inner text', () => {
      const b = block(
        'paragraph',
        'Middleware in <Config>cds.requires.auth.impl</Config>, by providing a path relative to the project root.'
      )
      assert.strictEqual(
        transform(b),
        'Middleware in cds.requires.auth.impl, by providing a path relative to the project root.'
      )
    })
  })

  describe('when transforming a fence', () => {
    it('should preserve inner content verbatim', () => {
      const code = '```js\nconst foo =   bar()\n  indented()\n```'
      const b = block('fence', code)
      assert.strictEqual(transform(b), code)
    })

    it('should preserve non-log fence content exactly', () => {
      const code =
        '```js\n[cds] - repeated\n[cds] - repeated\n[cds] - repeated\n[cds] - repeated\n[cds] - repeated\n[cds] - repeated\n```'
      const b = block('fence', code)
      assert.strictEqual(transform(b), code)
    })

    it('should collapse path runs longer than 3 in a log fence without [!code focus]', () => {
      const paths = [
        '   gen/db/src/gen/AdminService.Authors.hdbview',
        '   gen/db/src/gen/AdminService.Books.hdbview',
        '   gen/db/src/gen/AdminService.Genres.hdbview',
        '   gen/db/src/gen/CatalogService.Books.hdbview',
        '   gen/db/src/gen/CatalogService.Genres.hdbview'
      ]
      const text = '```log\n[cds] - done > wrote output to:\n' + paths.join('\n') + '\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(result.includes(paths[0]), 'first path kept')
      assert.ok(result.includes(paths[paths.length - 1]), 'last path kept')
      assert.ok(result.includes('   ...'), 'summary inserted')
      assert.ok(!result.includes(paths[2]), 'middle paths removed')
    })

    it('should not collapse a log fence path run of 3 or fewer', () => {
      const paths = [
        '   gen/db/src/gen/A.hdbview',
        '   gen/db/src/gen/B.hdbview',
        '   gen/db/src/gen/C.hdbview'
      ]
      const text = '```log\n[cds] - done:\n' + paths.join('\n') + '\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(result.includes(paths[1]), 'middle path kept when <=3')
    })

    it('should group log fence path runs by parent directory', () => {
      const text =
        '```log\n[cds] - done:\n   gen/a/file1.txt\n   gen/a/file2.txt\n   gen/a/file3.txt\n   gen/a/file4.txt\n   gen/b/file1.txt\n   gen/b/file2.txt\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(result.includes('gen/a/file1.txt'), 'first of group a')
      assert.ok(result.includes('gen/a/file4.txt'), 'last of group a')
      assert.ok(result.includes('gen/b/file1.txt'), 'group b (<=3, all kept)')
      assert.ok(result.includes('gen/b/file2.txt'), 'group b kept')
    })

    it('should keep only focus-marked lines in a log fence with [!code focus]', () => {
      const text =
        '```log\n[cds] - done > wrote output to:\n   gen/db/init.js // [!code focus]\n   gen/db/package.json\n   gen/db/src/gen/AdminService.Authors.hdbview // [!code focus]\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(result.includes('gen/db/init.js'), 'focused line kept')
      assert.ok(result.includes('AdminService.Authors.hdbview'), 'focused line kept')
      assert.ok(!result.includes('gen/db/package.json'), 'unfocused line dropped')
      assert.ok(!result.includes('[!code focus]'), 'marker stripped from output')
    })

    it('should preserve opener and closer in a log fence with [!code focus]', () => {
      const text = '```log\nsome line // [!code focus]\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(result.startsWith('```log'), 'opener preserved')
      assert.ok(result.endsWith('```'), 'closer preserved')
    })

    it('should keep only Python # [!code focus]-marked lines and strip the marker', () => {
      const text =
        '```log\n[cds] - done:\n   gen/db/init.py # [!code focus]\n   gen/db/other.py\n   gen/db/keep.py # [!code focus]\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(result.includes('gen/db/init.py'), 'python focused line kept')
      assert.ok(result.includes('gen/db/keep.py'), 'second python focused line kept')
      assert.ok(!result.includes('gen/db/other.py'), 'unfocused line dropped')
      assert.ok(!result.includes('[!code focus]'), 'marker stripped from output')
    })

    it('should be idempotent', () => {
      const code = '```js\nconst x = 1\n```'
      const b1 = block('fence', code)
      const first = transform(b1)
      const b2 = block('fence', first)
      assert.strictEqual(transform(b2), first)
    })

    it('should normalize only line endings, not content', () => {
      const b = block('fence', '```\r\nfoo()\r\n```')
      assert.strictEqual(transform(b), '```\nfoo()\n```')
    })

    it('should preserve [!code --] diff markers verbatim in a non-log fence', () => {
      const text = '```js\nconst x = 1 // [!code --]\nconst x = 2\n```'
      const b = block('fence', text)
      assert.ok(
        transform(b).includes('[!code --]'),
        '[!code --] diff marker must survive non-log fence transform'
      )
    })

    it('should preserve [!code ++] diff markers verbatim in a non-log fence', () => {
      const text = '```js\nconst x = 1\nconst x = 2 // [!code ++]\n```'
      const b = block('fence', text)
      assert.ok(
        transform(b).includes('[!code ++]'),
        '[!code ++] diff marker must survive non-log fence transform'
      )
    })
  })

  describe('when applying shared normalization rules', () => {
    it('should collapse 3+ blank lines to 2', () => {
      const b = block('paragraph', 'a\n\n\n\nb')
      assert.strictEqual(transform(b), 'a\n\nb')
    })

    it('should remove HTML stub lines', () => {
      const b = block('paragraph', 'text\n<br/>\nmore')
      const result = transform(b)
      assert.ok(!result.includes('<br/>'), 'stub line removed')
      assert.ok(result.includes('text'), 'real content kept')
      assert.ok(result.includes('more'), 'real content kept')
    })

    it('should keep non-stub HTML', () => {
      const b = block('paragraph', 'See the <a href="/docs">docs</a> here.')
      const result = transform(b)
      assert.ok(result.includes('<a href="/docs">'), 'anchor kept')
    })

    it('should trim leading and trailing whitespace', () => {
      const b = block('paragraph', '  \n\nactual content\n\n  ')
      assert.strictEqual(transform(b), 'actual content')
    })

    it('should normalize CRLF line endings', () => {
      const b = block('paragraph', 'line one\r\nline two')
      assert.strictEqual(transform(b), 'line one\nline two')
    })

    it('should strip trailing {...} attr block before stub test', () => {
      // '<br/> {.class}' — without stripTrailingAttrBlock the {.class} would prevent stub detection
      const b = block('paragraph', 'text\n<br/> {.class}\nmore')
      const result = transform(b)
      assert.ok(!result.includes('<br/>'), 'stub line with trailing attr dropped')
      assert.ok(result.includes('text'), 'real content kept')
      assert.ok(result.includes('more'), 'real content kept')
    })

    it('should strip {lang=js} and {key="v"} attrs, not just {.class}', () => {
      const b = block('paragraph', 'text\n<div> {lang=js}\nmore')
      const result = transform(b)
      assert.ok(!result.includes('<div>'), 'stub line with arbitrary attr dropped')
    })

    it('should convert <iframe src> in a paragraph to video (url) and not drop it', () => {
      const url = 'https://www.youtube.com/embed/abc123'
      const b = block('paragraph', `text\n<iframe src="${url}" allowfullscreen></iframe>\nmore`)
      const result = transform(b)
      assert.ok(result.includes(`video (${url})`), `iframe converted: ${result}`)
      assert.ok(result.includes('text'), 'surrounding text kept')
    })

    it('should preserve <iframe> inner description text alongside video (url)', () => {
      const b = block(
        'paragraph',
        '<iframe src="/demo/video">Watch this video about setup</iframe>'
      )
      assert.strictEqual(transform(b), 'video (/demo/video): Watch this video about setup')
    })

    it('should drop <div id> stub lines and keep surrounding content', () => {
      const b = block('paragraph', '<div id="events" />\nReal content follows.')
      const result = transform(b)
      assert.ok(!result.includes('<div id='), 'anchor stub dropped')
      assert.ok(result.includes('Real content follows.'), 'surrounding content kept')
    })

    it('should drop <span id> stub lines and keep surrounding content', () => {
      const b = block('paragraph', '<span id="afterAddingData" />\nContent after anchor.')
      const result = transform(b)
      assert.ok(!result.includes('<span id='), 'span anchor stub dropped')
      assert.ok(result.includes('Content after anchor.'), 'surrounding content kept')
    })

    it('should pass > Source: lines through as blockquote prose when embedded in a paragraph', () => {
      const b = block('paragraph', 'Background info.\n> Source: /docs/guides/foo\nMore text.')
      const result = transform(b)
      assert.ok(
        result.includes('> Source: /docs/guides/foo'),
        'source line preserved as blockquote'
      )
    })
  })

  describe('when stripping class markers', () => {
    it('should strip {.class} from paragraph', () => {
      const b = block('paragraph', 'Some text {.tip} here.')
      assert.strictEqual(transform(b), 'Some text here.')
    })

    it('should strip {#id} from paragraph', () => {
      const b = block('paragraph', 'Heading content {#my-anchor}')
      assert.strictEqual(transform(b), 'Heading content')
    })

    it('should strip {.class #id} combined marker', () => {
      const b = block('paragraph', 'Text {.warning #warn-1} more.')
      assert.strictEqual(transform(b), 'Text more.')
    })

    it('should strip <UnderConstruction/> tag', () => {
      const b = block('paragraph', 'This feature <UnderConstruction/> is coming.')
      assert.strictEqual(transform(b), 'This feature is coming.')
    })

    it('should preserve {.class} inside backtick span', () => {
      const b = block('paragraph', 'Use `{.class}` in your template.')
      assert.ok(transform(b).includes('`{.class}`'), 'inline code preserved')
    })

    it('should strip {.class} from bullet-item opener', () => {
      const b = itemBlock('- item one {.active}')
      const result = transform(b)
      assert.ok(!result.includes('{.active}'), 'marker stripped')
      assert.ok(result.includes('item one'), 'content kept')
    })

    it('should drop a line that becomes empty after marker stripping', () => {
      const b = block('paragraph', 'real content\n{.orphan-marker}\nmore content')
      const result = transform(b)
      assert.ok(!result.includes('{.orphan-marker}'), 'marker line dropped')
      assert.ok(result.includes('real content'), 'content kept')
      assert.ok(result.includes('more content'), 'content kept')
    })

    it('should preserve blank lines between content', () => {
      const b = block('paragraph', 'a\n\nb')
      assert.strictEqual(transform(b), 'a\n\nb')
    })

    it('should strip {.good}, {.bad}, {.abstract} structural role markers from paragraph', () => {
      assert.strictEqual(
        transform(block('paragraph', 'Some good example. {.good}')),
        'Some good example.'
      )
      assert.strictEqual(transform(block('paragraph', 'Avoid this. {.bad}')), 'Avoid this.')
      assert.strictEqual(
        transform(block('paragraph', 'Overview text. {.abstract}')),
        'Overview text.'
      )
    })

    it('should strip a {target="_blank"} trailing attribute from a link', () => {
      const b = block('paragraph', '[Learn more](/docs/guide){target="_blank"}')
      assert.strictEqual(transform(b), 'Learn more (/docs/guide)')
    })

    it('should strip a {#entities} anchor from a heading block and keep the heading text', () => {
      const b = block('heading', '## CDS Entities {#entities}')
      const result = transform(b)
      assert.ok(!result.includes('{#entities}'), '{#entities} anchor stripped from heading')
      assert.ok(result.includes('CDS Entities'), 'heading text kept')
    })
  })

  describe('when stripping heading extras', () => {
    it('should strip inline image from heading', () => {
      const b = block('heading', '## Title ![x](img.svg)')
      assert.strictEqual(transform(b), '## Title')
    })

    it('should decode numeric HTML entity in heading', () => {
      const b = block('heading', '## Title &#8594; Next')
      assert.strictEqual(transform(b), '## Title → Next')
    })

    it('should decode numeric entity in heading (re:cap brand name)', () => {
      const b = block('heading', '## re&#8829;cap 26')
      assert.strictEqual(transform(b), '## re≽cap 26')
    })

    it('should strip remaining {} from heading', () => {
      const b = block('heading', '## Title {}')
      assert.strictEqual(transform(b), '## Title')
    })

    it('should keep the beta in heading', () => {
      const b = block('heading', '#### Native Fetch Client <Beta />')
      assert.strictEqual(transform(b), '#### Native Fetch Client (Beta)')
    })

    it('should not strip inline image from paragraph (heading-only concern)', () => {
      const b = block('paragraph', 'See ![diagram](img.svg) for details')
      assert.ok(transform(b).includes('diagram'), 'alt text kept in paragraph')
    })
  })

  describe('when normalizing a list item', () => {
    it('should strip markers, jsx, images, inline html, decodes entities, resolves links', () => {
      const b = itemBlock('- <Tip>note</Tip> {.class} <em>text</em> &amp; [x](../g.md)')
      const result = transform(b, '> Source: /docs/java/ref.md')
      assert.ok(!result.includes('<Tip>'), 'jsx stripped')
      assert.ok(!result.includes('{.class}'), 'marker stripped')
      assert.ok(!result.includes('<em>'), 'inline html stripped')
      assert.ok(result.includes('&'), 'entity decoded')
      assert.ok(result.includes('x (/docs/g)'), 'link resolved: ' + result)
    })

    it('should apply the same pipeline to a list-item as to a bullet-item', () => {
      const b = itemBlock('1. item <Badge/> text')
      const result = transform(b)
      assert.ok(!result.includes('<Badge'), 'jsx stripped')
      assert.ok(result.includes('item'), 'content kept')
    })

    it('should collapse multi-space runs outside backticks (same as paragraph)', () => {
      const b = itemBlock('- run  npm  install  now')
      const result = transform(b)
      assert.ok(!result.includes('  '), `double spaces must be collapsed; got: ${result}`)
      assert.ok(result.includes('run npm install now'), `content kept; got: ${result}`)
    })

    it('should not collapse spaces inside backtick spans', () => {
      const b = itemBlock('- run `npm   install` now')
      const result = transform(b)
      assert.ok(
        result.includes('`npm   install`'),
        `spaces inside backticks preserved; got: ${result}`
      )
    })

    it('should preserve bold **(a)** labels in a bullet-item opener', () => {
      const b = itemBlock('- **(a)** Adjust foreign keys to use the new column.')
      const result = transform(b)
      assert.ok(result.includes('**(a)**'), '**(a)** bold label must survive normalizeListItem')
      assert.ok(result.includes('Adjust foreign keys'), 'content kept')
    })
  })

  describe('when transforming a bullet-item', () => {
    it('should preserve opener text', () => {
      const b = itemBlock('- item one')
      assert.ok(transform(b).includes('item one'))
    })

    it('should transform nested bullet items in parts', () => {
      const b = itemBlock('- item one\n  - nested')
      const result = transform(b)
      assert.ok(result.includes('item one'))
      assert.ok(result.includes('nested'))
    })

    it('should strip <Config> tags and keep inner text in a bullet opener (BUG-3)', () => {
      const b = itemBlock(
        '- Java: <Config java keyOnly>cds.sql.hana.search.fuzzinessThreshold = 0.8</Config>'
      )
      const result = transform(b)
      assert.ok(result.includes('cds.sql.hana.search.fuzzinessThreshold = 0.8'), 'inner text kept')
      assert.ok(!result.includes('<Config'), 'Config tag stripped')
    })

    it('should strip <Since/> self-closing tags from a bullet opener (BUG-3)', () => {
      const b = itemBlock('- Available <Since package="@sap/cds" version="v10" /> since v10.')
      const result = transform(b)
      assert.ok(!result.includes('<Since'), 'Since tag stripped')
      assert.ok(result.includes('Available'), 'surrounding text kept')
      assert.ok(result.includes('since v10'), 'trailing text kept')
    })
  })

  describe('when transforming a md-table', () => {
    it('should preserve column relationships', () => {
      const text = '| col1 | col2 |\n|------|------|\n| a | b |'
      const b = block('md-table', text)
      const result = transform(b)
      assert.ok(result.includes('col1'))
      assert.ok(result.includes('col2'))
      assert.ok(result.includes('| a |'))
    })

    it('should compact multi-space padding in cells', () => {
      const b = block('md-table', '|   value   |   other   |\n|-----------|-----------|')
      const result = transform(b)
      assert.ok(!result.includes('  '), 'no double spaces')
    })

    it('should collapse repeated dashes in separator row', () => {
      const b = block('md-table', '| a | b |\n|------|------|')
      const result = transform(b)
      assert.ok(result.includes('|-|') || result.match(/\|-+\|/), 'separator compacted')
      assert.ok(!result.includes('------'), 'no long dash run')
    })

    it('should collapse multi-space runs in cell text outside backticks', () => {
      const b = block('md-table', '| run  npm  install | `keep  spaces` |\n|---|---|')
      const result = transform(b)
      // Outside-backtick cell content must have no double spaces
      const firstRow = result.split('\n')[0]
      const outsideBackticks = firstRow.replace(/`[^`]*`/g, '``')
      // Split on | to get individual cell strings, check each for double spaces
      const cells = outsideBackticks.split('|').map((c) => c.trim())
      assert.ok(
        cells.every((c) => !/ {2,}/.test(c)),
        `double spaces outside backticks must collapse; got: ${firstRow}`
      )
      assert.ok(result.includes('`keep  spaces`'), 'spaces inside backticks preserved')
    })

    it('should be idempotent', () => {
      const text = '| col1 | col2 |\n|------|------|\n| a | b |'
      const b1 = block('md-table', text)
      const first = transform(b1)
      const b2 = block('md-table', first)
      assert.strictEqual(transform(b2), first)
    })

    it('should strip {.class} markers from cells (BUG-4)', () => {
      const text = '| `hana` | [Learn more](/docs/hana#cfg){.learn-more} |\n|--------|------|'
      const b = block('md-table', text)
      const result = transform(b, '> Source: /docs/guides/deploy/build#build-task-types')
      assert.ok(!result.includes('{.learn-more}'), '{.learn-more} stripped from table cell')
      assert.ok(result.includes('Learn more'), 'link text preserved')
    })

    it('should decode feature-table status icons to readable labels', () => {
      const text = `| Messaging Broker                                       | Support |         Cause          |
                    | ------------------------------------------------------ | :-----: | :--------------------: |
                    | [File Base Messaging](#local-testing)                  |  <Na/>  |                        |
                    | [Event Mesh](#configuring-sap-event-mesh-support)      |  <X/>   | removed from the queue |
                    | [Message Queuing](#configuring-sap-event-mesh-support) |  <X/>   | removed from the queue |
                    | [Redis PubSub](#configuring-redis-pubsub-support-beta) | <Beta/> |                        |`
      const b = block('md-table', text)
      const result = transform(b, '> Source: /docs/guides/deploy/build#build-task-types')
      assert.ok(!result.includes('<X/>'), '<X/> decoded, not left as raw tag')
      assert.ok(!result.includes('<Na/>'), '<Na/> decoded, not left as raw tag')
      assert.ok(!result.includes('<Beta/>'), '<Beta/> decoded, not left as raw tag')
      assert.ok(result.includes('Yes'), '<X/> decoded to "Yes"')
      assert.ok(result.includes('N/A'), '<Na/> decoded to "N/A"')
      assert.ok(result.includes('Beta'), '<Beta/> decoded to "Beta"')
    })

    it('should decode <D/> and <Y/> status icons', () => {
      const text =
        '| Feature | Node.js | Java |\n|---------|---------|------|\n| `$search` | <X/> | <Na/> |\n| `$compute` | <X/> | <D/> |\n| experimental | <Y/> | <Na/> |'
      const b = block('md-table', text)
      const result = transform(b)
      assert.ok(!result.includes('<D/>'), '<D/> decoded')
      assert.ok(!result.includes('<Y/>'), '<Y/> decoded')
      assert.ok(result.includes('Deprecated'), '<D/> decoded to "Deprecated"')
      const rows = result
        .split('\n')
        .filter((l) => l.trim().startsWith('|') && !l.trim().match(/^\|\s*[-:]+\s*\|/))
      assert.ok(
        rows.every((r) => r.replace(/\|/g, '').trim().length > 0),
        'no empty-cell rows'
      )
    })

    it('should decode mixed <X/><sup><Beta/></sup> cell content', () => {
      const text =
        '| Method | Status |\n|--------|--------|\n| `cds.serve` | <X/><sup><Beta/></sup> |'
      const b = block('md-table', text)
      const result = transform(b)
      assert.ok(!result.includes('<X/>'), '<X/> decoded in mixed cell')
      assert.ok(!result.includes('<Beta/>'), '<Beta/> decoded in mixed cell')
      assert.ok(result.includes('Yes'), 'Yes present')
      assert.ok(result.includes('Beta'), 'Beta present')
    })

    it('should decode <O/> in a md-table cell', () => {
      const text =
        '| Feature | Node.js | Java |\n|---------|---------|------|\n| draft | <X/> | <O/> |'
      const b = block('md-table', text)
      const result = transform(b)
      assert.ok(!result.includes('<O/>'), '<O/> must not appear as raw tag in output')
      assert.ok(result.includes('no'), 'no must appear in output')
    })

    it('should decode &emsp; to "> " separator preserving hierarchy in a table cell', () => {
      const text = '| `CountRestrictions`<br />&emsp;`/Countable` | EntitySet |\n|---|---|'
      const result = transform(block('md-table', text))
      assert.ok(result.includes('CountRestrictions'), 'parent term kept')
      assert.ok(result.includes('/Countable'), 'child term kept')
      assert.ok(result.includes('> '), '&emsp; decoded to "> " hierarchy marker')
      assert.ok(!result.includes('&emsp;'), 'no raw &emsp; entity')
    })

    it('should decode double &emsp;&emsp; to "> > " for two-level nesting', () => {
      const text = '| &emsp;&emsp;`/Deeper` | EntitySet |\n|---|---|'
      const result = transform(block('md-table', text))
      assert.ok(result.includes('> > '), 'double emsp decoded to "> > "')
      assert.ok(!result.includes('&emsp;'), 'no raw &emsp;')
    })
  })

  describe('when converting html-table rows', () => {
    it('should convert <tr><td> row to pipe-separated markdown', () => {
      const b = block('html-table', '<table><tr><td>a</td><td>b</td></tr></table>')
      const result = transform(b)
      assert.ok(result.includes('| a | b |'), result)
    })

    it('should drop row where all cells strip to empty', () => {
      const b = block(
        'html-table',
        '<table><tr><td>  </td><td></td></tr><tr><td>real</td></tr></table>'
      )
      const result = transform(b)
      assert.ok(!result.includes('|  |'), 'empty row dropped')
      assert.ok(result.includes('real'), 'non-empty row kept')
    })

    it('should join <li> items inside <td> with " / "', () => {
      const b = block(
        'html-table',
        '<table><tr><td><ul><li>one</li><li>two</li></ul></td></tr></table>'
      )
      const result = transform(b)
      assert.ok(result.includes('one / two'), result)
    })
  })

  describe('when transforming an html-table', () => {
    it('should strip table wrapper tags, keeps cell content', () => {
      const text = '<table>\n  <tr><td>foo</td><td>bar</td></tr>\n</table>'
      const b = block('html-table', text)
      const result = transform(b)
      assert.ok(result.includes('foo'), 'cell content kept')
      assert.ok(result.includes('bar'), 'cell content kept')
      assert.ok(!result.includes('<table>'), 'table tag stripped')
      assert.ok(!result.includes('<td>'), 'td tag stripped')
    })

    it('should convert <a href> to markdown link', () => {
      const text = '<table><tr><td><a href="/docs/guide">Guide</a></td></tr></table>'
      const b = block('html-table', text)
      const result = transform(b)
      assert.ok(result.includes('Guide (/docs/guide)'), result)
    })

    it('should emit the URL for an <a href> with icon-only inner content', () => {
      // Icon-only link: inner strips to empty after STRIP_TAGS. URL must survive as bare path.
      const text =
        '<table><tr><td><a href="/docs/guide"><img src="icon.svg"/></a></td></tr></table>'
      const b = block('html-table', text)
      const result = transform(b)
      assert.ok(result.includes('/docs/guide'), `URL must survive icon-only link; got: ${result}`)
    })

    it('should resolve relative href against source', () => {
      const text = '<table><tr><td><a href="../plugins/">Plugins</a></td></tr></table>'
      const b = block('html-table', text)
      const result = transform(b, '> Source: /docs/authentication/oauth')
      assert.ok(result.includes('Plugins (/docs/plugins'), result)
    })

    it('should strip thead/tbody/tr wrapper tags', () => {
      const text =
        '<table>\n  <thead><tr><th>Col</th></tr></thead>\n  <tbody><tr><td>val</td></tr></tbody>\n</table>'
      const b = block('html-table', text)
      const result = transform(b)
      assert.ok(result.includes('Col'), 'header kept')
      assert.ok(result.includes('val'), 'cell kept')
      assert.ok(!result.includes('<thead>'), 'thead stripped')
      assert.ok(!result.includes('<tbody>'), 'tbody stripped')
    })

    it('should decode HTML entities', () => {
      const text = '<table><tr><td>Get&nbsp;Started</td><td>price &gt; 0</td></tr></table>'
      const b = block('html-table', text)
      const result = transform(b)
      assert.ok(result.includes('Get Started'), 'nbsp decoded')
      assert.ok(result.includes('price > 0'), 'gt decoded')
    })

    it('should remove whitespace-only lines after tag stripping', () => {
      const text = '<table>\n   <tr>\n      <td>content</td>\n   </tr>\n</table>'
      const b = block('html-table', text)
      const result = transform(b)
      assert.ok(
        !result
          .split('\n')
          .some((l) =>
            l.trim() === ''
              ? false
              : l !== l.trim() && l.trim() === 'content'
                ? false
                : /^\s+$/.test(l)
          ),
        'no whitespace-only lines'
      )
      assert.ok(result.includes('content'))
    })

    it('should trim leading and trailing whitespace per line', () => {
      const text = '<table><tr><td>   spaced   </td></tr></table>'
      const b = block('html-table', text)
      const result = transform(b)
      assert.ok(result.includes('spaced'), 'content kept')
      assert.ok(!result.includes('   spaced'), 'leading spaces stripped')
    })

    it('should preserve column relationships with | separators', () => {
      const text = `<table>
  <thead><tr><th>Property</th><th>Type</th><th>Description</th></tr></thead>
  <tbody>
    <tr><td>timeout</td><td>number</td><td>Max wait in ms</td></tr>
    <tr><td>retries</td><td>number</td><td>Number of retries</td></tr>
  </tbody>
</table>`
      const b = block('html-table', text)
      const result = transform(b)
      const lines = result.split('\n')
      assert.ok(
        lines.some((l) => l.includes('| Property | Type | Description |')),
        'header row with separators'
      )
      assert.ok(
        lines.some((l) => l.includes('| timeout | number | Max wait in ms |')),
        'data row with separators'
      )
    })

    it('should correctly transform a real-world multi-row html-table with nested lists, anchors, entities, and br', () => {
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
</table>`
      const b = block('html-table', text)
      const result = transform(b, '> Source: /docs/')
      const lines = result.split('\n')
      assert.ok(
        lines.some((l) => l.includes('| Section |') && l.includes('Description')),
        'header row'
      )
      assert.ok(
        lines.some(
          (l) =>
            l.includes('Get Started (/docs/index)') &&
            l.includes('Develop (/docs/guides)') &&
            l.includes('Deploy (/docs/guides/deploy)')
        ),
        'first data row — links on one line, resolved'
      )
      assert.ok(
        lines.some(
          (l) => l.includes('Plugins (/docs/plugins)') && l.includes('Releases (/docs/releases)')
        ),
        'second data row'
      )
      assert.ok(
        lines.some((l) =>
          l.includes(
            'Get Started (/docs/index) / Develop (/docs/guides) / Deploy (/docs/guides/deploy)'
          )
        ),
        'list items slash-separated'
      )
      assert.ok(!result.includes('&nbsp;'), 'no raw entities')
      assert.ok(!result.split('\n').some((l) => /^\s+$/.test(l)), 'no whitespace-only lines')
      assert.ok(!result.includes('\n\n'), 'no blank lines between rows')
    })

    it('should strip Vue directives from attrs and keep th text and Config inner text in a vue-template table', () => {
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
      </table>`
      const b = block('html-table', text)
      const result = transform(b)
      const lines = result.split('\n')
      assert.ok(
        lines.some((l) => l === '| Property | Type | Default Value | Description |'),
        `header row: ${result}`
      )
      assert.ok(
        lines.some((l) => l.startsWith('| {{p.name}}=') && l.endsWith(' |')),
        `data row keeps Config inner text: ${result}`
      )
      assert.ok(!result.includes('v-for'), 'v-for stripped')
      assert.ok(!result.includes('v-html'), 'v-html stripped')
      assert.ok(!result.includes('<Config'), '<Config tag stripped')
      assert.ok(!result.includes('<td'), '<td tag stripped')
    })

    it('should flatten <br/> and &emsp; hierarchy encoding to plain text in an html-table cell', () => {
      const b = block(
        'html-table',
        '<table><tr><td>CountRestrictions<br />&emsp;/Countable</td></tr></table>'
      )
      const result = transform(b)
      assert.ok(result.includes('CountRestrictions'), 'parent term kept')
      assert.ok(result.includes('/Countable'), 'child term kept')
      assert.ok(!result.includes('<br'), 'no raw <br> in output')
      assert.ok(!result.includes('&emsp;'), 'no raw &emsp; in output')
    })
  })

  describe('when transforming a java-div or node-div', () => {
    it('should prepend a Java: label to a java-div', () => {
      const b = itemBlock('<div class="impl java">\n\nsome java content\n\n</div>')
      const result = transform(b)
      assert.ok(result.startsWith('Java:'), 'label prepended')
      assert.ok(result.includes('some java content'), 'content kept')
      assert.ok(!result.includes('<div'), 'outer div tag stripped')
    })

    it('should prepend a Node.js: label to a node-div', () => {
      const b = itemBlock('<div class="impl node">\n\nsome node content\n\n</div>')
      const result = transform(b)
      assert.ok(result.startsWith('Node.js:'), 'label prepended')
      assert.ok(result.includes('some node content'), 'content kept')
    })

    it('should preserve a fence inside a java-div verbatim', () => {
      const text = '<div class="impl java">\n\n```sh\nmvn spring-boot:run\n```\n\n</div>'
      const b = itemBlock(text)
      const result = transform(b)
      assert.ok(result.includes('mvn spring-boot:run'), 'fence content kept')
      assert.ok(result.includes('Java:'), 'label present')
    })

    it('should resolve relative links inside a java-div', () => {
      const text = '<div class="impl java">\n\nSee [guide](../guides/)\n\n</div>'
      const b = itemBlock(text)
      const result = transform(b, '> Source: /docs/get-started/')
      assert.ok(result.includes('/docs/guides'), 'relative link resolved')
    })

    it('should apply the full transform to the inner paragraph of a java-div', () => {
      const text =
        '<div class="impl java">\n\nText with   extra   spaces and {.tip} marker.\n\n</div>'
      const b = itemBlock(text)
      const result = transform(b)
      assert.ok(!result.includes('  '), 'multi-spaces collapsed')
      assert.ok(!result.includes('{.tip}'), 'class marker stripped')
      assert.ok(result.includes('Text with extra spaces and marker.'), 'content kept')
    })

    it('should strip inner image markup from a java-div', () => {
      const text = '<div class="impl java">\n\n![diagram.png](./x.png)\n\n</div>'
      const b = itemBlock(text)
      const result = transform(b)
      assert.ok(!result.includes('!['), 'image syntax removed')
    })

    it('should preserve all content in a real-world java-div containing a container with an inner fence', () => {
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
        '</div>'
      ].join('\n')
      const b = itemBlock(text)
      const result = transform(b)
      assert.ok(result.startsWith('Java:'), 'label prepended')
      assert.ok(result.includes('@RunWith(SpringRunner.class)'), 'fence content kept')
      assert.ok(result.includes('testViewer'), 'test method kept')
      assert.ok(result.includes('testUnauthorized'), 'test method kept')
      assert.ok(!result.includes('<div'), 'outer div stripped')
      assert.ok(result.includes(':::'), 'container delimiters stripped')
    })
  })

  describe('when transforming a container', () => {
    it('should preserve both fences in a container', () => {
      const text =
        '::: code-group\n```shell [macOS]\nbrew install node\n```\n```shell [Windows]\nwinget install node\n```\n:::'
      const b = itemBlock(text)
      const result = transform(b)
      assert.ok(result.includes('brew install node'), 'macOS fence kept')
      assert.ok(result.includes('winget install node'), 'Windows fence kept')
      assert.ok(!result.includes('::: code-group'), 'container opener stripped')
      assert.ok(!result.includes(':::'), 'container closer stripped')
    })

    it('should transform a paragraph inside a container', () => {
      const text = '::: tip\nSome   spaced   text {.tip} here.\n:::'
      const b = itemBlock(text)
      const result = transform(b)
      assert.ok(result.includes('Some spaced text here.'), 'paragraph normalized')
      assert.ok(!result.includes('{.tip}'), 'class marker stripped')
    })

    it('should strip {.class} markers from container opener line (BUG-4)', () => {
      const text =
        '::: details **Best Practice:**{.good} Use `@mandatory` instead.\nSome detail text.\n:::'
      const b = itemBlock(text)
      const result = transform(b)
      assert.ok(!result.includes('{.good}'), '{.good} stripped from container opener')
      assert.ok(result.includes('Best Practice'), 'opener text preserved')
    })

    it('should preserve :::opener title as flat prose', () => {
      const admonitions = ['details', 'danger', 'info', 'tip', 'warning']
      for (const admon of admonitions) {
        const b = itemBlock(`:::${admon} Alternative manual setup\nSome inner text.\n:::`)
        const result = transform(b)
        assert.ok(result.includes(`:::${admon} Alternative manual setup`), 'opener title preserved')
      }
    })
  })

  describe('when transforming a cols-div', () => {
    it('should transform inner paragraphs in a cols-div', () => {
      const text =
        '<div class="cols-2">\n<div>\nsome   content {.tip}\n</div>\n<div>\nother content\n</div>\n</div>'
      const b = itemBlock(text)
      const result = transform(b)
      assert.ok(result.includes('some content'), 'first col content kept')
      assert.ok(result.includes('other content'), 'second col content kept')
      assert.ok(!result.includes('{.tip}'), 'marker stripped')
      assert.ok(!result.includes('<div'), 'div tags stripped')
    })
  })

  describe('when transforming an admonition', () => {
    it('should preserve [!TYPE] marker line exactly', () => {
      const text = '> [!NOTE]\n> This is important.'
      const b = block('admonition', text)
      assert.strictEqual(transform(b), text)
    })

    it('should preserve [!WARNING] type', () => {
      const text = '> [!WARNING]\n> Be careful.'
      const b = block('admonition', text)
      assert.ok(transform(b).includes('[!WARNING]'))
    })

    it('should strip <Since/> from the admonition opener (BUG-3)', () => {
      const b = {
        type: 'admonition',
        opener: '::: details Available for CAP Node.js <Since package="@sap/cds" version="v10" />',
        text: '::: details Available for CAP Node.js <Since package="@sap/cds" version="v10" />',
        parts: [{ type: 'paragraph', text: 'Some content.', supressCut: false }],
        supressCut: true
      }
      const result = transform(b)
      assert.ok(!result.includes('<Since'), 'Since tag stripped from opener')
      assert.ok(result.includes('Available for CAP Node.js'), 'opener text kept')
    })

    it('should strip <Beta/> from the admonition opener (BUG-3)', () => {
      const b = block('admonition', '> [!warning] Java only and <Beta/>')
      const result = transform(b)
      assert.ok(!result.includes('<Beta'), 'Beta tag stripped')
      assert.ok(result.includes('Java only'), 'text kept')
    })
  })

  describe('when stripping inline HTML tags (BUG-6)', () => {
    it('should replace a mid-line <br> with a space in a paragraph', () => {
      const b = block('paragraph', 'first line<br>second line')
      const result = transform(b)
      assert.ok(!result.includes('<br'), 'br tag stripped')
      assert.ok(result.includes('first line'), 'text before kept')
      assert.ok(result.includes('second line'), 'text after kept')
    })

    it('should replace a mid-line <br/> with a space in a paragraph', () => {
      const b = block('paragraph', 'inbound<br/>outbound')
      const result = transform(b)
      assert.ok(!result.includes('<br'), 'br/ tag stripped')
      assert.ok(result.includes('inbound'), 'text before kept')
      assert.ok(result.includes('outbound'), 'text after kept')
    })

    it('should strip <sup> footnote markers and keep inner text', () => {
      const b = block('paragraph', 'See note<sup>(1)</sup> for details.')
      const result = transform(b)
      assert.ok(!result.includes('<sup>'), 'sup tag stripped')
      assert.ok(result.includes('(1)'), 'inner text kept')
    })

    it('should keep the Beta label when <Beta/> is nested inside <sup>', () => {
      const b = block('paragraph', 'Supported<sup><Beta/></sup> in preview.')
      const result = transform(b)
      assert.ok(!result.includes('<sup>'), 'sup tag stripped')
      assert.ok(!result.includes('<Beta/>'), 'Beta tag stripped')
      assert.ok(
        result.includes('(Beta)') || result.includes('Beta'),
        'Beta label kept after nested JSX+sup strip'
      )
    })

    it('should strip <em> tags and keep inner text', () => {
      const b = block('paragraph', 'Use <em>cds watch</em> to develop.')
      const result = transform(b)
      assert.ok(!result.includes('<em>'), 'em tag stripped')
      assert.ok(result.includes('cds watch'), 'inner text kept')
    })

    it('should strip <strong> tags and keep inner text', () => {
      const b = block('paragraph', '<strong>USAGE</strong>')
      const result = transform(b)
      assert.ok(!result.includes('<strong>'), 'strong tag stripped')
      assert.ok(result.includes('USAGE'), 'inner text kept')
    })

    it('should strip <i> tags and keep inner text in a paragraph', () => {
      const b = block('paragraph', "CAP-level Service Integration (<i>'Calesi'</i>)")
      const result = transform(b)
      assert.ok(!result.includes('<i>'), 'i tag stripped')
      assert.ok(result.includes("'Calesi'"), 'inner text kept')
    })

    it('should strip <br> from a md-table cell', () => {
      const b = block('md-table', '| col |\n|-----|\n| value<br>more |')
      const result = transform(b)
      assert.ok(!result.includes('<br'), 'br stripped from table cell')
      assert.ok(result.includes('value'), 'cell text kept')
    })

    it('should strip <sup> from a md-table cell', () => {
      const b = block('md-table', '| feature | supported<sup>(1)</sup> |\n|-|-|')
      const result = transform(b)
      assert.ok(!result.includes('<sup>'), 'sup stripped from table')
      assert.ok(result.includes('(1)'), 'footnote marker kept')
    })

    it('should strip <br> from a bullet-item opener', () => {
      const b = itemBlock('- inbound<br>outbound')
      const result = transform(b)
      assert.ok(!result.includes('<br'), 'br stripped from bullet')
      assert.ok(result.includes('inbound'), 'text kept')
    })

    it('should unwrap <details><summary> and preserve inner content', () => {
      const b = block(
        'paragraph',
        '<details><summary>In more detail <code>cds deploy</code> does the following...</summary>\n\n* step one\n* step two\n\n</details>'
      )
      const result = transform(b)
      assert.ok(!result.includes('<details>'), 'details tag stripped')
      assert.ok(!result.includes('<summary>'), 'summary tag stripped')
      assert.ok(result.includes('In more detail'), 'summary text kept')
      assert.ok(result.includes('cds deploy'), 'inner code text kept')
    })
  })

  describe('when the result is empty', () => {
    it('should set isEmpty when result is empty', () => {
      const b = block('paragraph', '   \n\n   ')
      transform(b)
      assert.strictEqual(b.isEmpty, true)
    })

    it('should not set isEmpty for non-empty result', () => {
      const b = block('paragraph', 'content here')
      transform(b)
      assert.ok(!b.isEmpty)
    })
  })

  describe('when resolving links', () => {
    it('should preserve link label and url when no source given', () => {
      const text = 'See the [Attachments plugin](../plugins/index#attachments).'
      const b = block('paragraph', text)
      assert.ok(transform(b).includes('Attachments plugin (../plugins/index#attachments)'))
    })

    it('should resolve relative link against source URL', () => {
      const b = block('paragraph', 'See [Attachments](../plugins/index#attachments).')
      const result = transform(b, '> Source: /docs/authentication/oauth')
      assert.ok(result.includes('Attachments (/docs/plugins/index#attachments)'), result)
    })

    it('should pass absolute links through unchanged', () => {
      const b = block('paragraph', 'See [CAP](https://cap.cloud.sap/docs).')
      const result = transform(b, '> Source: /docs/authentication/oauth')
      assert.ok(result.includes('https://cap.cloud.sap/docs'))
    })

    it('should resolve a fragment-only link against the source hash path', () => {
      const b = block('paragraph', 'See [section](#config).')
      const result = transform(b, '> Source: /docs/auth/oauth#setup')
      assert.ok(result.includes('/docs/auth/oauth#config'), result)
    })

    it('should pass absolute path links through unchanged', () => {
      const b = block('paragraph', 'See [page](/docs/other).')
      const result = transform(b, '> Source: /docs/auth/oauth')
      assert.ok(result.includes('/docs/other'))
    })

    it('should resolve a ref-style link definition', () => {
      const text = '[label]: ../plugins/index'
      const b = block('paragraph', text)
      const result = transform(b, '> Source: /docs/auth/oauth')
      assert.ok(result.includes('/docs/plugins/index'), result)
    })
  })

  describe('when transforming image markup', () => {
    it('should keep meaningful alt text as plain text', () => {
      const b = block('paragraph', '![Architecture overview](./arch.png)')
      assert.strictEqual(transform(b), 'Architecture overview')
    })

    it('should drop a filename-style alt entirely', () => {
      const b = block('paragraph', '![arch.png](./arch.png)')
      assert.strictEqual(transform(b), '')
    })

    it('should drop boilerplate alt text entirely', () => {
      const b = block('paragraph', '![This graphic is explained in the accompanying text](./x.png)')
      assert.strictEqual(transform(b), '')
    })

    it('should use the title attribute when it is longer than the alt', () => {
      const b = block('paragraph', '![img](./x.png "Full descriptive title here")')
      assert.strictEqual(transform(b), 'Full descriptive title here')
    })

    it('should drop an empty alt and preserve surrounding text', () => {
      const b = block('paragraph', 'See below: ![](./x.png) for details.')
      const result = transform(b)
      assert.ok(!result.includes('![]'), 'empty image removed')
      assert.ok(result.includes('See below'), 'surrounding text kept')
    })

    it('should replace an image with its meaningful alt text when inside a sentence', () => {
      const b = block('paragraph', 'Use the ![save icon](./save.svg) button.')
      const result = transform(b)
      assert.ok(result.includes('save icon'), 'alt kept')
      assert.ok(!result.includes('!['), 'image syntax removed')
    })

    it('should strip an empty {} brace from an image and keep the alt text', () => {
      const b = block('paragraph', 'See ![Architecture overview](./arch.png) {} for details.')
      const result = transform(b)
      assert.ok(!result.includes('{}'), 'empty brace stripped')
      assert.ok(result.includes('Architecture overview'), 'alt text kept')
    })

    it('should keep the alt text as a link label for badge images (real pattern from llms-full.txt)', () => {
      const text =
        '[![Node.js](/logos/nodejs.svg){}](https://github.com/cap-js/ai)\n[![Java](/logos/java.svg){}](https://github.com/cap-java/cds-ai)'
      const b = block('paragraph', text)
      const result = transform(b, '> Source: /docs/plugins/ai')
      assert.ok(
        result.includes('Node.js (https://github.com/cap-js/ai)'),
        `Node.js link must survive: ${result}`
      )
      assert.ok(
        result.includes('Java (https://github.com/cap-java/cds-ai)'),
        `Java link must survive: ${result}`
      )
      assert.ok(!result.includes('!['), 'image syntax must be stripped')
    })

    it('should extract rich alt text verbatim from a .drawio.svg diagram', () => {
      const alt =
        'CAP-level service integration with two scenarios: Local services where Consumer connects to Service via CQL, and Remote services where Consumer connects to Proxy via CQL'
      const b = block('paragraph', `![${alt}](../guides/integration/assets/remoting.drawio.svg)`)
      assert.strictEqual(transform(b), alt)
    })

    it('should flag isEmpty when a .drawio.svg has an empty alt', () => {
      const b = block('paragraph', '![](./assets/bookshop-service.drawio.svg)')
      const result = transform(b)
      assert.strictEqual(result, '')
      assert.strictEqual(b.isEmpty, true)
    })

    it('should produce an empty result for a .excalidraw.svg with an empty alt', () => {
      const b = block('paragraph', '![](./assets/diagram.excalidraw.svg)')
      assert.strictEqual(transform(b), '')
    })

    it('should strip a {.ignore-dark} suffix and keep the alt text', () => {
      const b = block('paragraph', '![Architecture overview](./arch.drawio.svg){.ignore-dark}')
      assert.strictEqual(transform(b), 'Architecture overview')
    })

    it('should strip a space-only {} brace suffix and keep the alt text', () => {
      const b = block('paragraph', '![Architecture overview](./arch.drawio.svg){ }')
      assert.strictEqual(transform(b), 'Architecture overview')
    })

    it('should keep the alt text and strip the {.ignore-dark} suffix from a diagram', () => {
      const alt = 'Overview of the CAP architecture with Java and Node.js runtimes'
      const b = block('paragraph', `![${alt}](./overview.drawio.svg){.ignore-dark}`)
      assert.strictEqual(transform(b), alt)
    })

    it('should preserve <iframe> inner description text as embedding context', () => {
      const b = block(
        'paragraph',
        '<iframe src="https://example.com/demo">Watch this video about CAP setup</iframe>'
      )
      const result = transform(b)
      assert.ok(result.includes('video (https://example.com/demo)'), 'URL survives as video (url)')
      assert.ok(
        result.includes('Watch this video about CAP setup'),
        'description text must survive — currently dropped by convertMediaEmbeds'
      )
    })
  })

  describe('when the transform runs twice (idempotency)', () => {
    it('should be idempotent for a paragraph', () => {
      const text = 'Some text   with   unnecessary  spacing.'
      const b1 = block('paragraph', text)
      const first = transform(b1)
      const b2 = block('paragraph', first)
      assert.strictEqual(transform(b2), first)
    })

    it('should be idempotent for an admonition', () => {
      const text = '> [!NOTE]\n> Content here.'
      const b1 = block('admonition', text)
      const first = transform(b1)
      const b2 = block('admonition', first)
      assert.strictEqual(transform(b2), first)
    })

    it('should produce no trailing newline when a paragraph ends with a stripped image', () => {
      const raw =
        "[![Node.js logo](/logos/nodejs.svg 'Link.'){}](https://github.com/cap-js/audit-logging#readme)\n![Java](/logos/java.svg){}"
      const b = block('paragraph', raw)
      const result = transform(b, '> Source: /docs/plugins/#audit-logging')
      assert.ok(
        !result.endsWith('\n'),
        `paragraph must not end with \\n after image strip; got: ${JSON.stringify(result)}`
      )
    })

    it('should produce empty result and set isEmpty when a paragraph contains only a stripped image', () => {
      const raw = '![arch.drawio](./arch.drawio)'
      const b = block('paragraph', raw)
      transform(b, '> Source: /docs/a#b')
      assert.ok(b.isEmpty, 'paragraph reduced to empty by image strip must set isEmpty=true')
    })

    it('should preserve real text and produce no trailing whitespace when an image is stripped from a paragraph', () => {
      const raw = 'Some prose here.\n\n![decorative](./diagram.drawio)'
      const b = block('paragraph', raw)
      const result = transform(b, '> Source: /docs/a#b')
      assert.ok(result.includes('Some prose here.'), 'prose must survive')
      assert.strictEqual(
        result,
        result.trim(),
        `result must be fully trimmed; got: ${JSON.stringify(result)}`
      )
    })
  })

  describe('when stripping custom component tags', () => {
    function para(text) {
      return { type: 'paragraph', text }
    }

    it('should keep inner text of a <Config> paired tag', () => {
      const result = transform(para('Ports: <Config> cds.server.port = 4005 </Config> or env var.'))
      assert.strictEqual(result, 'Ports: cds.server.port = 4005 or env var.')
    })

    it('should prepend a Java: runtime prefix for <Config java>', () => {
      const result = transform(
        para(
          'enable <Config java keyOnly>cds.sql.hana.search.fuzzy = true</Config> for fuzzy search'
        )
      )
      assert.strictEqual(result, 'enable Java: cds.sql.hana.search.fuzzy = true for fuzzy search')
    })

    it('should keep inner text of an inline <Config keyOnly>', () => {
      const result = transform(
        para('Node.js: <Config keyOnly>cds.query.limit.reliablePaging: true</Config>')
      )
      assert.strictEqual(result, 'Node.js: cds.query.limit.reliablePaging: true')
    })

    it('should prefix "Tip:" to inner text of a <Tip> paired tag', () => {
      assert.strictEqual(transform(para('<Tip>use cds.serve</Tip>')), 'Tip: use cds.serve')
    })

    it('should prefix "Warning:" to inner text of a <Warning> paired tag', () => {
      assert.strictEqual(
        transform(para('<Warning>breaking change</Warning>')),
        'Warning: breaking change'
      )
    })

    it('should prefix "Danger:" to inner text of a <Danger> paired tag', () => {
      assert.strictEqual(transform(para('<Danger>data loss</Danger>')), 'Danger: data loss')
    })

    it('should keep inner text of a <CdsSrv link="..."> paired tag', () => {
      const result = transform(
        para('Use <CdsSrv link="services/ErrorStatus.html">ErrorStatus</CdsSrv> to handle errors.')
      )
      assert.strictEqual(result, 'Use ErrorStatus to handle errors.')
    })

    it('should keep inner text of a <Cds4j link="..."> paired tag', () => {
      const result = transform(
        para('See <Cds4j link="ql/cqn/CqnLimit.html">CqnLimit</Cds4j> for details.')
      )
      assert.strictEqual(result, 'See CqnLimit for details.')
    })

    it('should replace a <Since .../> self-closing tag with a "Since <package> <version>" label', () => {
      const result = transform(
        para('Available <Since package="@sap/cds" version="v10" /> since version 10.')
      )
      assert.strictEqual(result, 'Available (Since @sap/cds v10) since version 10.')
    })

    it('should replace <Beta/> with a "(Beta)" label', () => {
      const result = transform(para('This feature is <Beta/> and may change.'))
      assert.strictEqual(result, 'This feature is (Beta) and may change.')
    })

    it('should decode <Na/> to "N/A"', () => {
      const result = transform(para('<Na/> Not applicable.'))
      assert.strictEqual(result, 'N/A Not applicable.')
    })

    it('should handle multiple custom tags in one paragraph', () => {
      const result = transform(
        para(
          'Java: <Config java keyOnly>cds.query.limit.reliablePaging.enabled: true</Config>\n\n' +
            'Node.js: <Config keyOnly>cds.query.limit.reliablePaging: true</Config>'
        )
      )
      assert.strictEqual(
        result,
        'Java: Java: cds.query.limit.reliablePaging.enabled: true\n\nNode.js: cds.query.limit.reliablePaging: true'
      )
    })

    it('should unwrap attribute-bearing <span> tags', () => {
      const result = transform(para('See <span class="highlight">important</span> note.'))
      assert.strictEqual(result, 'See important note.')
    })

    it('should unwrap attribute-bearing <div> tags', () => {
      const result = transform(para('<div id="x">content</div>'))
      assert.strictEqual(result, 'content')
    })

    it('should not touch a plain <span> without attributes', () => {
      // plain <span> has no space after tag name so unwrapAttributedSpans skips it
      // (stripped later by stripInlineHtml or convertHtmlToMarkdown)
      const result = transform(para('plain text'))
      assert.strictEqual(result, 'plain text')
    })

    it('should clamp parent link traversal at /docs root', () => {
      const b = block('paragraph', '[x](../../../../etc.md)')
      const result = transform(b, '> Source: /docs/guides/foo.md')
      assert.match(result, /x \(\/docs\/etc\)/, `expected clamp at /docs; got: ${result}`)
    })

    it('should leave #/ SPA fragments unchanged', () => {
      const b = block('paragraph', '[x](#/route/thing)')
      const result = transform(b, '> Source: /docs/a/b.md')
      assert.match(result, /x \(#\/route\/thing\)/)
    })

    it('should replace alt text with the title when the title is longer', () => {
      const b = block('paragraph', '![short](/x "much longer title text")')
      const result = transform(b, '> Source: /docs/a')
      assert.ok(result.includes('much longer title text'))
      assert.ok(!result.includes('short'))
    })

    it('should preserve unknown named entities verbatim', () => {
      const b = block('paragraph', 'foo &foobar; bar')
      const result = transform(b, '')
      assert.ok(result.includes('&foobar;'), `unknown entity must survive; got: ${result}`)
    })

    it('should convert <iframe src="url"> in an html-table to video (url)', () => {
      const b = block(
        'html-table',
        '<table><tr><td><iframe src="https://example.com/v"></iframe></td></tr></table>'
      )
      const result = transform(b, '')
      assert.ok(
        result.includes('video (https://example.com/v)'),
        `expected video (...); got: ${result}`
      )
    })

    it('should convert <video src="url"> in an html-table to video (url)', () => {
      const b = block(
        'html-table',
        '<table><tr><td><video src="https://example.com/demo.mp4"></video></td></tr></table>'
      )
      const result = transform(b, '')
      assert.ok(
        result.includes('video (https://example.com/demo.mp4)'),
        `expected video (...); got: ${result}`
      )
    })

    it('should drop a <tr> whose cells all strip to empty from an html-table', () => {
      const b = block(
        'html-table',
        ['<table>', '<tr><td>real</td></tr>', '<tr><td>   </td><td></td></tr>', '</table>'].join(
          '\n'
        )
      )
      const result = transform(b, '')
      const rows = result.split('\n').filter((l) => l.startsWith('|'))
      assert.strictEqual(rows.length, 1, `expected one row; got: ${JSON.stringify(rows)}`)
      assert.ok(rows[0].includes('real'))
    })

    it('should join <ul><li> items inside a <td> with " / "', () => {
      const b = block(
        'html-table',
        '<table><tr><td><ul><li>a</li><li>b</li><li>c</li></ul></td></tr></table>'
      )
      const result = transform(b, '')
      assert.ok(result.includes('a / b / c'), `expected joined items; got: ${result}`)
    })

    it('should emit opener and inner content with no undefined tail when a container has no closer', () => {
      const inner = { type: 'paragraph', text: 'hello', supressCut: false }
      const b = {
        type: 'container',
        opener: '::: tip',
        closer: null,
        parts: [inner],
        supressCut: true
      }
      const result = transform(b, '')
      assert.ok(!/undefined/.test(result), `no literal 'undefined'; got: ${result}`)
      assert.ok(result.startsWith('::: tip'))
      assert.ok(result.includes('hello'))
    })

    it('should mark isEmpty and produce empty text when a java-div has all-empty inner parts', () => {
      const emptyInner = {
        type: 'paragraph',
        text: '![filename.png](./x.png)',
        supressCut: false
      }
      const b = {
        type: 'java-div',
        opener: '<div class="impl java">',
        closer: '</div>',
        parts: [emptyInner],
        supressCut: false
      }
      const result = transform(b, '')
      assert.strictEqual(result, '')
      assert.strictEqual(b.isEmpty, true)
    })

    it('should not emit a bare "> " line when all admonition inner parts transform to empty', () => {
      const b = {
        type: 'admonition',
        opener: '> [!NOTE]',
        text: '> [!NOTE]\n> ![decorative](./x.drawio)',
        parts: [
          {
            type: 'paragraph',
            text: '![decorative](./x.drawio)',
            supressCut: false
          }
        ],
        supressCut: true
      }
      const result = transform(b, '')
      assert.ok(!/^>\s*$/m.test(result), `no bare '> ' line; got: ${JSON.stringify(result)}`)
    })

    it('should resolve links using the directory when source ends in /', () => {
      const b = block('paragraph', '[x](./sibling.md)')
      const result = transform(b, '> Source: /docs/guides/')
      assert.match(result, /\/docs\/guides\/sibling/, `got: ${result}`)
    })

    it('should throw when the link URL is a bracket-wrapped reference-style label (BUG-2)', () => {
      // Source doc bug: [`Null`]([annotation expression](#null-value))
      // The URL "[annotation expression](#null-value)" starts with '[' — must throw, not silently mangle.
      const b = block(
        'paragraph',
        'see [`Null`]([annotation expression](#null-value)) for details.'
      )
      assert.throws(
        () => transform(b, '> Source: /docs/guides/protocols/odata#expression-translation'),
        /resolveRelativeLinks: bracket in URL/,
        'expected throw on bracket-in-URL'
      )
    })

    it('should add a Java: runtime prefix to <Config java> inner text', () => {
      const b = block('paragraph', '<Config java keyOnly>cds.sql.hana.search.fuzzy = true</Config>')
      assert.strictEqual(transform(b), 'Java: cds.sql.hana.search.fuzzy = true')
    })

    it('should include the package attribute in the label when a version is present', () => {
      // Inline (non-stub) usage: package and version both emitted as "(Since <pkg> <ver>)"
      const b = block('paragraph', 'Available <Since version="v3.8" package="CAP Java"/> now.')
      assert.strictEqual(transform(b), 'Available (Since CAP Java v3.8) now.')
    })

    it('should keep the package label for each of two adjacent <Since> tags with different packages', () => {
      const b = block(
        'paragraph',
        '<Since version="v3.8" package="CAP Java"/> and <Since version="v9.1" package="CAP Node.js"/>'
      )
      assert.strictEqual(transform(b), '(Since CAP Java v3.8) and (Since CAP Node.js v9.1)')
    })

    it('should strip unknown PascalCase self-closing tags and keep surrounding text', () => {
      const b = block('paragraph', '<IndexList :pages="pages" /> See also the guide.')
      assert.strictEqual(transform(b), 'See also the guide.')
    })

    it('should produce an empty result for a paragraph containing only an unknown PascalCase self-closing tag', () => {
      const b = block('paragraph', '<IndexList :pages="pages" />')
      const result = transform(b)
      // stub line dropped by removeHtmlStubLines → empty → isEmpty flagged
      assert.strictEqual(result, '')
      assert.strictEqual(b.isEmpty, true)
    })

    it('should replace <Alpha/> with an "(Alpha)" label', () => {
      const result = transform(block('paragraph', 'This feature is <Alpha/> and experimental.'))
      assert.ok(result.includes('(Alpha)'), '(Alpha) label present')
      assert.ok(!result.includes('<Alpha'), 'raw tag gone')
    })

    it('should replace <Gamma/> with a "(Gamma)" label', () => {
      const result = transform(block('paragraph', 'Feature tier <Gamma/>.'))
      assert.ok(result.includes('(Gamma)'), '(Gamma) label present')
      assert.ok(!result.includes('<Gamma'), 'raw tag gone')
    })

    it('should replace <Internal/> with an "(SAP specific)" label', () => {
      const result = transform(block('paragraph', 'This API is <Internal/> only.'))
      assert.ok(result.includes('(SAP specific)'), '(SAP specific) label present')
      assert.ok(!result.includes('<Internal'), 'raw tag gone')
    })

    it('should not leak <ImplVariantsHint/> as a raw tag', () => {
      const result = transform(block('paragraph', 'See <ImplVariantsHint/> for details.'))
      assert.ok(
        !result.includes('<ImplVariantsHint'),
        '<ImplVariantsHint/> must not appear as raw tag'
      )
    })

    it('should decode <X/> and <Beta/> inside <sup> and not leak them as raw tags', () => {
      const result = transform(block('paragraph', 'Supported <X/><sup><Beta/></sup> in preview.'))
      assert.ok(!result.includes('<X/>'), '<X/> must not be raw in paragraph')
      assert.ok(!result.includes('<Beta/>'), '<Beta/> must not be raw in paragraph')
      assert.ok(result.includes('Yes'), '<X/> decoded to Yes')
    })
  })

  describe('when content must not be stripped', () => {
    // Group 1: Fence content

    it('should preserve [!code highlight] inside a fence verbatim (F1)', () => {
      const text = '```cds\nreviewTravel @from: #Open @to: #InReview; // [!code highlight]\n```'
      const b = block('fence', text)
      assert.ok(
        transform(b).includes('[!code highlight]'),
        '[!code highlight] must survive fence transform'
      )
    })

    it('should preserve the [filename] label in a fence opener (F2)', () => {
      const text = '```js [app.js]\nconst x = 1\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(
        result.startsWith('```js [app.js]'),
        `opener with [filename] must be unchanged; got: ${result}`
      )
    })

    it('should preserve entity-containing labels in a fence opener (F3)', () => {
      const text = '```sql [=>&nbsp; Compiled SQL query]\nSELECT * FROM Books\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(
        result.startsWith('```sql [=>&nbsp; Compiled SQL query]'),
        `opener with entity label must be unchanged; got: ${result}`
      )
    })

    it('should preserve empty lines inside a fence (F4)', () => {
      const text = '```js\nconst a = 1\n\nconst b = 2\n```'
      const b = block('fence', text)
      assert.ok(transform(b).includes('\n\n'), 'blank line inside fence must survive')
    })

    it('should preserve indentation inside a fence (F5)', () => {
      const text = '```java\npublic class Foo {\n  void bar() {\n    return;\n  }\n}\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(result.includes('  void bar()'), 'two-space indent must survive')
      assert.ok(result.includes('    return;'), 'four-space indent must survive')
    })

    it('should preserve a multiline template literal inside a fence (F6)', () => {
      const text = '```js\nconst q = `SELECT ${x}\nFROM y`\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(result.includes('SELECT ${x}'), 'first line of template literal must survive')
      assert.ok(result.includes('FROM y'), 'second line of template literal must survive')
    })

    it('should preserve @ CDS annotations inside a fence (F7)', () => {
      const text = '```cds\n@mandatory\nelement field : String;\n```'
      const b = block('fence', text)
      assert.ok(
        transform(b).includes('@mandatory'),
        '@mandatory annotation must survive fence transform'
      )
    })

    it('should preserve $self and $user dollar-prefix identifiers inside a fence (F8)', () => {
      const text = '```cds\nbooks : Association to many Books on books.author = $self;\n```'
      const b = block('fence', text)
      assert.ok(transform(b).includes('$self'), '$self must survive fence transform')
    })

    // Group 2: Prose / paragraph

    it('should not treat the || pipe operator in prose as a table delimiter (P1)', () => {
      const b = block('paragraph', 'Use A || B for string concatenation.')
      assert.ok(transform(b).includes('||'), '|| must survive in prose')
    })

    it('should preserve the => arrow in prose (P2)', () => {
      const b = block('paragraph', 'cds <src>  =>  cds compile <src>')
      assert.ok(transform(b).includes('=>'), '=> must survive in prose')
    })

    it('should preserve the → Unicode arrow in prose (P3)', () => {
      const b = block('paragraph', 'Passive data is immutable → allows parallelization.')
      assert.ok(transform(b).includes('→'), '→ Unicode arrow must survive')
    })

    it('should preserve --- horizontal rule lines inside a paragraph (P4)', () => {
      const b = block('paragraph', 'before\n\n---\n\nafter')
      assert.ok(transform(b).includes('---'), '--- separator line must survive')
    })

    it('should not mangle > blockquote lines in a paragraph (P5)', () => {
      const b = block('paragraph', '> This is a quote\n> spanning two lines')
      const result = transform(b)
      assert.ok(result.includes('> This is a quote'), '> prefix on first line must survive')
      assert.ok(result.includes('> spanning'), '> prefix on second line must survive')
    })

    it('should preserve double-backtick spans (P6)', () => {
      const b = block('paragraph', 'Use ``code with `backtick` inside`` as raw span.')
      assert.ok(
        transform(b).includes('``code with `backtick` inside``'),
        'double-backtick span must survive'
      )
    })

    it('should preserve OData $skip, $top, and $expand query params in prose (P7)', () => {
      const b = block('paragraph', 'Try GET /Books?$skip=10&$top=5&$expand=author.')
      const result = transform(b)
      assert.ok(result.includes('$skip=10'), '$skip must survive')
      assert.ok(result.includes('$top=5'), '$top must survive')
      assert.ok(result.includes('$expand=author'), '$expand must survive')
    })

    // Group 3: md-table preservation

    it('should decode &check; to ✓ in a md-table cell (T1)', () => {
      const b = block('md-table', '| Feature | Supported |\n|-|-|\n| CRUD | &check; |')
      assert.ok(transform(b).includes('✓'), '&check; must decode to ✓ in table cell')
    })

    it('should decode &rarr; to → in a md-table cell (T2)', () => {
      const b = block('md-table', '| From | To |\n|-|-|\n| A | B &rarr; C |')
      assert.ok(transform(b).includes('→'), '&rarr; must decode to → in table cell')
    })

    it('should decode &nbsp; and leave no raw entity in a md-table cell (T3)', () => {
      const b = block('md-table', '| Section |\n|-|\n| Get&nbsp;Started |')
      const result = transform(b)
      assert.ok(!result.includes('&nbsp;'), '&nbsp; must not appear raw in output')
      assert.ok(result.includes('Get'), 'cell text must survive')
    })

    it('should preserve alignment colons in the separator row (T4)', () => {
      const b = block('md-table', '| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |')
      const result = transform(b)
      assert.ok(result.includes(':'), 'alignment colons must survive in separator row')
    })

    it('should preserve pipe inside backtick spans in a md-table cell (T5)', () => {
      const b = block(
        'md-table',
        '| Handler | Syntax |\n|-|-|\n| register | `<hook:on|before|after>` |'
      )
      const result = transform(b)
      assert.ok(
        result.includes('`<hook:on|before|after>`'),
        'pipe inside backtick in table cell must survive'
      )
    })

    it('should not strip {.class} inside backticks in a md-table cell (T6)', () => {
      const b = block('md-table', '| Example | Usage |\n|-|-|\n| `{.class}` | add to element |')
      const result = transform(b)
      assert.ok(
        result.includes('`{.class}`'),
        '{.class} inside backtick in table cell must survive'
      )
    })

    // Group 4: Admonition preservation

    it('should preserve ordered list items inside an admonition (A1)', () => {
      const text = '> [!NOTE]\n> 1. First step\n> 2. Second step\n> 3. Third step'
      const b = block('admonition', text)
      const result = transform(b)
      assert.ok(result.includes('1. First step'), '1. list item must survive in admonition')
      assert.ok(result.includes('2. Second step'), '2. list item must survive')
      assert.ok(result.includes('3. Third step'), '3. list item must survive')
    })

    it('should preserve bold and italic inside an admonition body (A2)', () => {
      const text = '> [!TIP]\n> Use **bold** for emphasis and *italic* for terms.'
      const b = block('admonition', text)
      const result = transform(b)
      assert.ok(result.includes('**bold**'), '**bold** must survive in admonition body')
      assert.ok(result.includes('*italic*'), '*italic* must survive in admonition body')
    })

    it('should preserve inline code inside an admonition body (A3)', () => {
      const text = '> [!NOTE]\n> Run `cds watch` to start dev server.'
      const b = block('admonition', text)
      assert.ok(transform(b).includes('`cds watch`'), 'backtick span must survive in admonition')
    })

    // Group 5: Container preservation

    it('should preserve inner fences inside a 4-colon code-group container (C1)', () => {
      const text =
        ':::: code-group\n```shell [macOS]\nbrew install node\n```\n```shell [Windows]\nwinget install node\n```\n::::'
      const b = itemBlock(text)
      const result = transform(b)
      assert.ok(
        result.includes('brew install node'),
        'macOS fence content must survive 4-colon container'
      )
      assert.ok(
        result.includes('winget install node'),
        'Windows fence content must survive 4-colon container'
      )
    })

    it('should preserve container opener prose text after class-marker stripping (C2)', () => {
      const text = '::: tip **Best Practice:** Use open version ranges.\nSome detail.\n:::'
      const b = itemBlock(text)
      const result = transform(b)
      assert.ok(result.includes('Best Practice'), 'opener prose must survive container transform')
      assert.ok(result.includes('**Best Practice:**'), 'bold in opener must survive')
    })

    // Group 6: Inline code backtick protection

    it('should not mangle pipe inside backtick spans in a paragraph (I1)', () => {
      const b = block('paragraph', 'Use `<hook:on|before|after>` as the handler signature.')
      assert.ok(
        transform(b).includes('`<hook:on|before|after>`'),
        'pipe inside backtick must survive in paragraph'
      )
    })

    it('should preserve => inside backtick spans (I2)', () => {
      const b = block('paragraph', 'Arrow function `x => x + 1` is shorthand.')
      assert.ok(transform(b).includes('`x => x + 1`'), '=> inside backtick must survive')
    })

    it('should not strip {.class} inside backtick spans in a paragraph (I3)', () => {
      const b = block('paragraph', 'Add `{.class}` to the markdown element.')
      assert.ok(
        transform(b).includes('`{.class}`'),
        '{.class} inside backtick in paragraph must not be stripped'
      )
    })

    it('should preserve Vue template bindings {{ versions.X }} verbatim (P8)', () => {
      const b = block('paragraph', 'Requires CAP Java {{ versions.java_services }} or later.')
      assert.strictEqual(transform(b), 'Requires CAP Java {{ versions.java_services }} or later.')
    })

    it('should strip inline PascalCase XML self-closers like <Annotation/> (P9, content loss documented)', () => {
      // <Annotation .../> is a PascalCase self-closer with no JSX_BADGE_LABELS entry → resolves to ''
      // This documents the known loss so a regression (e.g. accidentally emitting raw tag) is caught.
      const b = block(
        'paragraph',
        'See <Annotation Term="Org.OData.Core.V1.Description" String="x"/> for details.'
      )
      assert.strictEqual(transform(b), 'See for details.')
    })

    // Group 7: Fence language tags (Section 3 risk findings)

    it('should preserve the ```cds language tag in a fence opener verbatim (F9)', () => {
      const text = '```cds\nentity Books { title : String; }\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(result.startsWith('```cds'), '```cds language tag must survive fence transform')
    })

    it('should preserve the ```[macOS] platform-only fence label verbatim (F10)', () => {
      const text = '```[macOS]\nbrew install node\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(
        result.startsWith('```[macOS]'),
        '```[macOS] platform label must survive; got: ' + result
      )
    })

    it('should preserve the ```[Windows] platform-only fence label verbatim (F11)', () => {
      const text = '```[Windows]\nwinget install node\n```'
      const b = block('fence', text)
      const result = transform(b)
      assert.ok(
        result.startsWith('```[Windows]'),
        '```[Windows] platform label must survive; got: ' + result
      )
    })

    // Group 8: Unicode characters (Section 6 risk findings)

    it('should preserve a literal en-dash (–) in prose unchanged (U1)', () => {
      const b = block('paragraph', 'Dependencies – with a leading caret – stay flexible.')
      assert.ok(transform(b).includes('–'), 'en-dash U+2013 must survive normalizeProse')
    })

    it('should preserve a literal em-dash (—) in prose unchanged (U2)', () => {
      const b = block('paragraph', 'CAP — Cloud Application Programming Model — is opinionated.')
      assert.ok(transform(b).includes('—'), 'em-dash U+2014 must survive normalizeProse')
    })

    it('should decode &ndash; to en-dash –, not hyphen (U3)', () => {
      const b = block('paragraph', 'Range: 1 &ndash; 10')
      const result = transform(b)
      assert.ok(
        result.includes('–'),
        '&ndash; must decode to – (U+2013), not be stripped or left as entity'
      )
      assert.ok(!result.includes('&ndash;'), 'raw &ndash; entity must not remain')
    })

    it('should decode &mdash; to em-dash — (U4)', () => {
      const b = block('paragraph', 'Note &mdash; this is important.')
      const result = transform(b)
      assert.ok(result.includes('—'), '&mdash; must decode to — (U+2014)')
      assert.ok(!result.includes('&mdash;'), 'raw &mdash; entity must not remain')
    })
  })
})

describe('transformSection', () => {
  const SECTION = {
    source: '> Source: /docs/node/x.md',
    heading: 'X',
    headingPath: ['X']
  }
  // A paragraph that holds only a filename image transforms to empty text.
  const emptyText = '![x.svg](a.svg)'

  it('should remove empty blocks, keep non-empty blocks, and set nonTransformedText', () => {
    const rawBlocks = [block('paragraph', 'Hello world.'), block('paragraph', emptyText)]
    const { nonEmpty, emptyBlocks, isEmptySection } = transformSection(SECTION, rawBlocks)
    assert.strictEqual(nonEmpty.length, 1)
    assert.strictEqual(nonEmpty[0].text, 'Hello world.')
    assert.strictEqual(nonEmpty[0].nonTransformedText, 'Hello world.')
    assert.strictEqual(emptyBlocks.length, 1)
    assert.strictEqual(isEmptySection, false)
  })

  it('should drop a trailing heading with no body and return it in emptyBlocks', () => {
    const rawBlocks = [block('paragraph', 'Body text.'), block('heading', '## Trailing')]
    const { nonEmpty, emptyBlocks } = transformSection(SECTION, rawBlocks)
    assert.strictEqual(nonEmpty.length, 1)
    assert.strictEqual(nonEmpty[0].type, 'paragraph')
    assert.strictEqual(emptyBlocks.length, 1)
    assert.strictEqual(emptyBlocks[0].block.type, 'heading')
    assert.strictEqual(emptyBlocks[0].section, SECTION)
  })

  it('should set isEmptySection true when all blocks in the section are empty', () => {
    const rawBlocks = [block('paragraph', emptyText)]
    const { nonEmpty, emptyBlocks, isEmptySection } = transformSection(SECTION, rawBlocks)
    assert.strictEqual(nonEmpty.length, 0)
    assert.strictEqual(isEmptySection, true)
    assert.strictEqual(emptyBlocks.length, 1)
  })

  it('should collect every dropped block in emptyBlocks for the stderr counts', () => {
    const rawBlocks = [
      block('paragraph', emptyText),
      block('paragraph', 'Real text.'),
      block('heading', '## End')
    ]
    const { nonEmpty, emptyBlocks } = transformSection(SECTION, rawBlocks)
    assert.strictEqual(nonEmpty.length, 1)
    assert.strictEqual(nonEmpty[0].text, 'Real text.')
    assert.strictEqual(emptyBlocks.length, 2)
  })
})
