import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../stages/01-parse.js';

const config = { maxHeadingDepth: 6 };

describe('parse', () => {
  describe('basic node output', () => {
    test('single h1 with body yields one root node', () => {
      const text = '# Title\n\n> Source: /docs/title\n\nSome body text.';
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].depth, 1);
      assert.equal(roots[0].title, 'Title');
      assert.match(roots[0].body, /Some body text./);
      assert.deepEqual(roots[0].children, []);
    });

    test('every node carries required fields with correct types (R06)', () => {
      const text = '# A\n\n> Source: /docs/a\n\nbody\n\n## B\n\n> Source: /docs/a#b\n\nbody b';
      const [a] = parse(text, config);
      for (const node of [a, a.children[0]]) {
        assert.equal(typeof node.depth, 'number');
        assert.equal(typeof node.title, 'string');
        assert.equal(typeof node.raw, 'string');
        assert.ok(Array.isArray(node.children));
        assert.equal(typeof node.source, 'string');
        assert.equal(typeof node.body, 'string');
      }
    });

    test('lines between headings belong to the preceding heading body (R05)', () => {
      const text = '# First\n\n> Source: /docs/first\n\nfirst body\n\n# Second\n\n> Source: /docs/second\n\nsecond body';
      const roots = parse(text, config);
      assert.match(roots[0].body, /first body/);
      assert.doesNotMatch(roots[0].body, /second body/);
      assert.match(roots[1].body, /second body/);
    });

    test('trailing lines after last heading appear in last node body (R11)', () => {
      const text = '# Only\n\n> Source: /docs/only\n\nline one\nline two\nline three';
      const [node] = parse(text, config);
      assert.match(node.body, /line one/);
      assert.match(node.body, /line three/);
    });

    test('adjacent headings with no lines between them produce correct independent nodes (R18)', () => {
      const text = [
        '# First',
        '',
        '> Source: /docs/first',
        '# Second',
        '',
        '> Source: /docs/second',
        '',
        'second body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 2);
      assert.equal(roots[0].title, 'First');
      assert.equal(roots[1].title, 'Second');
      assert.equal(typeof roots[0].body, 'string');
      assert.equal(typeof roots[0].source, 'string');
      assert.equal(typeof roots[1].body, 'string');
    });

    test('single heading with no body lines produces node with empty children and empty body (R19)', () => {
      const text = '# Solo\n\n> Source: /docs/solo';
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      assert.equal(roots[0].title, 'Solo');
      assert.deepEqual(roots[0].children, []);
      assert.equal(typeof roots[0].body, 'string');
    });

    test('node.raw is the verbatim heading line with no modification (R16)', () => {
      const headingLine = '## Exact Title Here';
      const text = `# Parent\n\n> Source: /docs/p\n\n${headingLine}\n\n> Source: /docs/p#child\n\nbody`;
      const roots = parse(text, config);
      assert.equal(roots[0].children[0].raw, headingLine);
    });

    test('node.title is trimmed of surrounding whitespace (R30)', () => {
      const text = '##  Padded Title  \n\n> Source: /docs/padded\n\nbody';
      const roots = parse(text, config);
      assert.equal(roots[0].title, 'Padded Title');
    });
  });

  describe('tree structure', () => {
    test('h1 > h2 > h3 nesting produces correct tree', () => {
      const text = '# A\n\n> Source: /docs/a\n\ntop\n\n## B\n\n> Source: /docs/a#b\n\nmid\n\n### C\n\n> Source: /docs/a#c\n\nleaf';
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      const a = roots[0];
      assert.equal(a.title, 'A');
      assert.equal(a.children.length, 1);

      const b = a.children[0];
      assert.equal(b.title, 'B');
      assert.equal(b.depth, 2);
      assert.equal(b.children.length, 1);

      const c = b.children[0];
      assert.equal(c.title, 'C');
      assert.equal(c.depth, 3);
      assert.match(c.body, /leaf/);
      assert.deepEqual(c.children, []);
    });

    test('h1 with no body but two h2 children', () => {
      const text = '# Root\n\n> Source: /docs/root\n\n## First\n\n> Source: /docs/root#first\n\none\n\n## Second\n\n> Source: /docs/root#second\n\ntwo';
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      const root = roots[0];
      assert.equal(root.title, 'Root');
      assert.equal(root.children.length, 2);
      assert.equal(root.children[0].title, 'First');
      assert.equal(root.children[1].title, 'Second');
    });

    test('shallower heading after deep nesting creates sibling not child (R10)', () => {
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
        'sibling',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      const root = roots[0];
      assert.equal(root.children.length, 2);
      assert.equal(root.children[0].title, 'A');
      assert.equal(root.children[1].title, 'B');
      assert.equal(root.children[0].children.length, 1);
      assert.equal(root.children[0].children[0].title, 'A1');
    });

    test('depth skip H1→H3→H2 places H2 as sibling of H3 under H1 (R14)', () => {
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
        'mid body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      const root = roots[0];
      assert.equal(root.children.length, 2);
      assert.equal(root.children[0].title, 'Deep');
      assert.equal(root.children[0].depth, 3);
      assert.equal(root.children[1].title, 'Mid');
      assert.equal(root.children[1].depth, 2);
      assert.equal(root.children[0].children.length, 0);
    });

    test('two top-level H1s both appear in roots (R15)', () => {
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
        'body two',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 2);
      assert.equal(roots[0].title, 'First');
      assert.equal(roots[1].title, 'Second');
      assert.equal(roots[0].children.length, 0);
      assert.equal(roots[1].children.length, 0);
    });

    test('three top-level headings all appear in roots in document order (R25)', () => {
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
        'body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 3);
      assert.equal(roots[0].title, 'One');
      assert.equal(roots[1].title, 'Two');
      assert.equal(roots[2].title, 'Three');
    });

    test('five consecutive deeper headings form a linear chain (R26)', () => {
      const text = [
        '# L1',      '', '> Source: /docs/l1', '',
        '## L2',     '', '> Source: /docs/l2', '',
        '### L3',    '', '> Source: /docs/l3', '',
        '#### L4',   '', '> Source: /docs/l4', '',
        '##### L5',  '', '> Source: /docs/l5', '', 'body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      const l2 = roots[0].children[0];
      const l3 = l2.children[0];
      const l4 = l3.children[0];
      const l5 = l4.children[0];
      assert.equal(roots[0].depth, 1);
      assert.equal(l2.depth, 2);
      assert.equal(l3.depth, 3);
      assert.equal(l4.depth, 4);
      assert.equal(l5.depth, 5);
    });

    test('second H1 after deep nesting becomes second root not a child (R27)', () => {
      const text = [
        '# First',   '', '> Source: /docs/first',  '',
        '## A',      '', '> Source: /docs/first#a', '',
        '### B',     '', '> Source: /docs/first#b', '',
        '#### C',    '', '> Source: /docs/first#c', '',
        '# Second',  '', '> Source: /docs/second',  '', 'body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 2);
      assert.equal(roots[0].title, 'First');
      assert.equal(roots[1].title, 'Second');
      assert.equal(roots[1].depth, 1);
      assert.equal(roots[1].children.length, 0);
    });

    test('H6 heading produces node with depth 6 (R23)', () => {
      const text = [
        '# Root',
        '',
        '> Source: /docs/root',
        '',
        '###### Leaf',
        '',
        '> Source: /docs/root#leaf',
        '',
        'deep body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      const leaf = roots[0].children[0];
      assert.equal(leaf.depth, 6);
      assert.equal(leaf.title, 'Leaf');
    });

    test('document starting with H2 places it as a root node (R24)', () => {
      const text = [
        '## Section',
        '',
        '> Source: /docs/section',
        '',
        'body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      assert.equal(roots[0].depth, 2);
      assert.equal(roots[0].title, 'Section');
    });

    test('node.depth matches the number of # characters on the heading line (R20)', () => {
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
        'body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots[0].depth, 1);
      assert.equal(roots[0].children[0].depth, 2);
      assert.equal(roots[0].children[0].children[0].depth, 4);
    });

    test('two consecutive H3s become siblings under same H2 (>= pop at non-root depth)', () => {
      const text = [
        '# H1', '', '> Source: /docs/a', '', 'top',
        '## H2', '', '> Source: /docs/a#b', '', 'mid',
        '### First', '', '> Source: /docs/a#f', '', 'one',
        '### Second', '', '> Source: /docs/a#s', '', 'two',
      ].join('\n');
      const roots = parse(text, config);
      const h2 = roots[0].children[0];
      assert.equal(h2.children.length, 2);
      assert.equal(h2.children[0].title, 'First');
      assert.equal(h2.children[1].title, 'Second');
    });
  });

  describe('source line recognition', () => {
    test('heading without > Source: is treated as body text', () => {
      const text = '# Real\n\n> Source: /docs/real\n\nsome body\n\n## No Source Here\n\njust text';
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].title, 'Real');
      assert.equal(roots[0].children.length, 0);
      assert.match(roots[0].body, /## No Source Here/);
    });

    test('heading at end of document with no following Source line is treated as body text (R21)', () => {
      const text = [
        '# Real',
        '',
        '> Source: /docs/real',
        '',
        'body',
        '',
        '## No Source At End',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      assert.equal(roots[0].children.length, 0);
      assert.match(roots[0].body, /## No Source At End/);
    });

    test('Source line 4+ lines after heading causes heading to be treated as body text (R22)', () => {
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
        'body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      assert.equal(roots[0].children.length, 0);
      assert.match(roots[0].body, /## Far Source/);
    });

    test('node with only a Source line in buffer gets source set and empty body (R28)', () => {
      const text = [
        '# Solo',
        '',
        '> Source: /docs/solo',
        '',
        '# Next',
        '',
        '> Source: /docs/next',
        '',
        'body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 2);
      assert.ok(roots[0].source.includes('/docs/solo'));
      assert.equal(roots[0].body, '');
    });

    test('adjacent promoted headings with empty scan window do not crash', () => {
      const text = [
        '# One', '> Source: /docs/one',
        '# Two', '> Source: /docs/two',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 2);
      assert.equal(roots[0].title, 'One');
      assert.equal(roots[1].title, 'Two');
    });
  });

  describe('guard: code fences', () => {
    test('# shell comment inside code fence is not a heading', () => {
      const text = '# Real Heading\n\n> Source: /docs/real\n\n```sh\n# install curl\napt-get install curl\n```\n\nafter';
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].title, 'Real Heading');
      assert.match(roots[0].body, /# install curl/);
    });

    test('~~~ fence delimiter also ignored', () => {
      const text = '# Real Heading\n\n> Source: /docs/real\n\n~~~sh\n# install curl\napt-get install curl\n~~~\n\nafter';
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].title, 'Real Heading');
      assert.match(roots[0].body, /# install curl/);
    });

    test('indented fence delimiters are recognised', () => {
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
        'after text',
      ].join('\n');
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].title, 'Real Heading');
      assert.match(roots[0].body, /# indented comment/);
    });

    test('4-backtick fence is recognised and closed by matching 4-backtick', () => {
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
        'child body',
      ].join('\n');
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].title, 'Real Heading');
      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'Real Child');
    });

    test('``` followed by semicolon does not close outer fence', () => {
      const text = [
        '# Real Heading',
        '',
        '> Source: /docs/real',
        '',
        '```cds [CDS Source]',
        'annotate Books with @sql.append: ```sql',
        '  GROUP TYPE foo',
        '```;',
        'annotate ListOfBooks with @sql.append: \'WITH DDL ONLY\';',
        '```',
        '',
        '## Should Be Child Heading',
        '',
        '> Source: /docs/real#child',
        '',
        'child body',
      ].join('\n');
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].title, 'Real Heading');
      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'Should Be Child Heading');
    });
  });

  describe('guard: container blocks :::', () => {
    test('code-group with multiple language tabs — headings inside all ignored', () => {
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
        'after text',
      ].join('\n');
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].title, 'Real Heading');
      assert.match(roots[0].body, /# macOS install comment/);
      assert.match(roots[0].body, /# Linux install comment/);
    });

    test('::: container block — headings inside ignored', () => {
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
        'child body',
      ].join('\n');
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].title, 'Real Heading');
      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'Real Child');
    });

    test('nested ::: containers — headings inside all ignored', () => {
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
        'child body',
      ].join('\n');
      const roots = parse(text, config);

      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'Real Child');
    });

    test('container-guarded heading does not shift lastHeadingIndex so later real heading is still recognised (R04)', () => {
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
        'body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'After Container');
    });

    test('container opened before previous heading does not affect guard for later heading (R29)', () => {
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
        'body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'Child');
    });

    test('heading demoted by container guard appears in enclosing node body (R17)', () => {
      const text = [
        '# Real',
        '',
        '> Source: /docs/real',
        '',
        '::: tip',
        '## Suppressed Heading',
        ':::',
        '',
        'after container',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      assert.equal(roots[0].children.length, 0);
      assert.match(roots[0].body, /## Suppressed Heading/);
    });
  });

  describe('guard: HTML divs', () => {
    test('heading inside <div class="java"> is not parsed as node', () => {
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
        'child body',
      ].join('\n');
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].title, 'Real Heading');
      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'Real Child');
    });

    test('heading inside <div class="cols-2"> is not parsed as node', () => {
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
        'child body',
      ].join('\n');
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'Real Child');
    });

    test('heading inside unclosed plain <div> is still parsed as node', () => {
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
        '</div>',
      ].join('\n');
      const roots = parse(text, config);

      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'Child Heading');
    });

    test('closed plain <div> before special div does not corrupt closer count', () => {
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
        'body',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'Real Child');
    });

    test('heading after closed special div is parsed correctly', () => {
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
        'body',
      ].join('\n');
      const roots = parse(text, config);

      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'After Div');
    });

    test('closed plain <div>...</div> between headings does not suppress next heading', () => {
      const text = [
        '# H1', '', '> Source: /docs/a', '', 'first',
        '<div>irrelevant</div>',
        '## H2', '', '> Source: /docs/a#b', '', 'second',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      assert.equal(roots[0].children.length, 1);
      assert.equal(roots[0].children[0].title, 'H2');
    });

    test('heading inside java-div with nested unclosed inner <div> is suppressed', () => {
      const text = [
        '# Root', '', '> Source: /docs/r', '', 'intro',
        '<div class="impl java">',
        '<div>',
        '## Should Not Promote', '', '> Source: /docs/r#nope', '', 'inner',
      ].join('\n');
      const roots = parse(text, config);
      assert.equal(roots.length, 1);
      assert.equal(roots[0].children.length, 0);
      assert.match(roots[0].body, /Should Not Promote/);
    });
  });

  describe('edge cases / invariants', () => {
    test('empty string yields empty roots array (R01)', () => {
      assert.deepEqual(parse('', config), []);
      assert.ok(Array.isArray(parse('', config)));
    });

    test('whitespace-only input yields empty roots array (R01/R13)', () => {
      const result = parse('   \n\n  ', config);
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 0);
    });

    test('headingless document returns empty array and emits preamble warning to stderr (R12)', () => {
      const stderrChunks = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...args) => { stderrChunks.push(String(chunk)); return orig(chunk, ...args); };
      try {
        const result = parse('just text\nno headings here', config);
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 0);
        assert.ok(stderrChunks.some(c => c.includes('[parse]')));
      } finally {
        process.stderr.write = orig;
      }
    });

    test('parse always returns an array regardless of input shape (R13)', () => {
      for (const input of ['', 'no headings', '# H\n\n> Source: /s\n\nbody']) {
        assert.ok(Array.isArray(parse(input, config)), `expected array for input: ${JSON.stringify(input)}`);
      }
    });

    test('text before first heading logs warning and is dropped', () => {
      const text = 'intro line before any heading\n\n# Title\n\n> Source: /docs/title\n\nbody';
      const roots = parse(text, config);

      assert.equal(roots.length, 1);
      assert.equal(roots[0].title, 'Title');
    });

    test('parse always collects all heading depths as tree nodes regardless of maxHeadingDepth', () => {
      const shallowConfig = { maxHeadingDepth: 2 };
      const text = '# A\n\n> Source: /docs/a\n\n## B\n\n> Source: /docs/a#b\n\n### C is a child node\n\n> Source: /docs/a#c\n\nmore text';
      const roots = parse(text, shallowConfig);

      assert.equal(roots.length, 1);
      const b = roots[0].children[0];
      assert.equal(b.title, 'B');
      assert.equal(b.children.length, 1);
      const c = b.children[0];
      assert.equal(c.title, 'C is a child node');
      assert.equal(c.depth, 3);
      assert.match(c.body, /more text/);
    });

    test('whitespace-only headingless input emits no preamble warning', () => {
      const orig = process.stderr.write.bind(process.stderr);
      let seen = '';
      process.stderr.write = (s) => { seen += s; return true; };
      try {
        parse('   \n\n  \n', config);
      } finally {
        process.stderr.write = orig;
      }
      assert.doesNotMatch(seen, /preamble/);
    });
  });
});
