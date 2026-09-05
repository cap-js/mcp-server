import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sectionize } from '../../stages/02-sectionize.js';

function node(title, source, body, depth, children = []) {
  return { title, source, body, depth, raw: '#'.repeat(depth) + ' ' + title, children };
}

describe('sectionize', () => {
  describe('basic section shape', () => {
    test('empty nodes array returns empty sections', () => {
      assert.deepEqual(sectionize([], {}), []);
    });

    test('single leaf node produces one section', () => {
      const n = node('Title', '> Source: /docs/title', 'Body text.', 1);
      const [s] = sectionize([n], {});
      assert.equal(s.heading, '# Title');
      assert.equal(s.depth, 1);
      assert.deepEqual(s.headingPath, ['Title']);
      assert.ok(s.source.includes('/docs/title'));
      assert.ok(s.body.includes('Body text.'));
      assert.ok(!s.body.includes('> Source:'), 'source line not in body');
    });

    test('source field contains the raw > Source: line', () => {
      const n = node('A', '> Source: /docs/path', 'Body.', 1);
      const [s] = sectionize([n], {});
      assert.equal(s.source, '> Source: /docs/path');
    });

    test('node with no source line: source is empty string', () => {
      const n = node('A', '', 'No source here.\nJust content.', 1);
      const [s] = sectionize([n], {});
      assert.equal(s.source, '');
      assert.ok(s.body.includes('No source here.'));
    });

    test('depth field matches heading depth', () => {
      const n = node('H3', '> Source: /a', 'body', 3);
      const [s] = sectionize([n], {});
      assert.equal(s.depth, 3);
    });

    test('heading field is the raw heading line', () => {
      const n = node('My Title', '> Source: /a', 'body', 2);
      const [s] = sectionize([n], {});
      assert.equal(s.heading, '## My Title');
    });
  });

  describe('tree sectionizeing', () => {
    test('parent and child both produce sections (depth-first order)', () => {
      const child = node('Child', '> Source: /docs/a#child', 'Child body.', 2);
      const parent = node('Parent', '> Source: /docs/a', 'Parent body.', 1, [child]);
      const sections = sectionize([parent], {});
      assert.equal(sections.length, 2);
      assert.equal(sections[0].heading, '# Parent');
      assert.equal(sections[1].heading, '## Child');
    });

    test('sections emitted depth-first', () => {
      const gc = node('GC', '> Source: /c', 'body', 3);
      const ch = node('Child', '> Source: /b', 'body', 2, [gc]);
      const pa = node('Parent', '> Source: /a', 'body', 1, [ch]);
      const sections = sectionize([pa], {});
      assert.deepEqual(sections.map(s => s.heading), ['# Parent', '## Child', '### GC']);
    });

    test('multiple roots all emitted', () => {
      const a = node('A', '> Source: /a', 'body', 1);
      const b = node('B', '> Source: /b', 'body', 1);
      const sections = sectionize([a, b], {});
      assert.equal(sections.length, 2);
      assert.equal(sections[0].heading, '# A');
      assert.equal(sections[1].heading, '# B');
    });
  });

  describe('headingPath', () => {
    test('root node headingPath is [title]', () => {
      const n = node('Root', '> Source: /a', 'body', 1);
      const [s] = sectionize([n], {});
      assert.deepEqual(s.headingPath, ['Root']);
    });

    test('child headingPath extends parent path', () => {
      const ch = node('Child', '> Source: /a#child', 'body', 2);
      const pa = node('Parent', '> Source: /a', 'body', 1, [ch]);
      const sections = sectionize([pa], {});
      assert.deepEqual(sections[1].headingPath, ['Parent', 'Child']);
    });

    test('grandchild headingPath includes all ancestors', () => {
      const gc = node('GC', '> Source: /c', 'body', 3);
      const ch = node('Child', '> Source: /b', 'body', 2, [gc]);
      const pa = node('Parent', '> Source: /a', 'body', 1, [ch]);
      const sections = sectionize([pa], {});
      assert.deepEqual(sections[2].headingPath, ['Parent', 'Child', 'GC']);
    });

    test('node with empty title does not add to headingPath', () => {
      const child = node('Real', '> Source: /b', 'body', 2);
      const preamble = { title: '', source: '', body: '', depth: 0, raw: '', children: [child] };
      const sections = sectionize([preamble], {});
      assert.deepEqual(sections[1].headingPath, ['Real']);
    });
  });

  describe('empty-body nodes / isEmptyLoner', () => {
    test('empty-body node with children is NOT skipped (has children to emit)', () => {
      const ch = node('Child', '> Source: /a#child', 'body', 2);
      const pa = node('Parent', '> Source: /a', '', 1, [ch]);
      const sections = sectionize([pa], {});
      // pa has children → not a loner → both emitted
      assert.equal(sections.length, 2);
      assert.equal(sections[0].heading, '# Parent');
      assert.equal(sections[1].heading, '## Child');
    });

    test('empty-body node kept when a later sibling at same depth has content', () => {
      const a = node('A', '> Source: /a', '', 1);
      const b = node('B', '> Source: /b', 'real content', 1);
      const sections = sectionize([a, b], {});
      assert.equal(sections.length, 2);
      assert.equal(sections[0].heading, '# A');
      assert.equal(sections[1].heading, '# B');
    });

    test('node with non-empty body always emitted even with no same-depth siblings', () => {
      const n = node('A', '> Source: /a', 'some content', 1);
      const sections = sectionize([n], {});
      assert.equal(sections.length, 1);
    });
  });

  describe('maxHeadingDepth folding', () => {
    test('node deeper than maxHeadingDepth is not emitted; body folds into nearest in-scope ancestor', () => {
      const deep = node('Deep', '> Source: /a#deep', 'Deep body.', 3);
      const parent = node('Parent', '> Source: /a', 'Parent body.', 2, [deep]);
      const sections = sectionize([parent], { maxHeadingDepth: 2 });
      assert.equal(sections.length, 1);
      assert.equal(sections[0].heading, '## Parent');
      assert.ok(sections[0].body.includes('Parent body.'));
      assert.ok(sections[0].body.includes('Deep body.'));
    });

    test('parent and child with empty body only keeps parent', () => {
      const deep = node('My Section', '> Source: /a#sec', '', 3);
      const parent = node('Parent', '> Source: /a', '', 2, [deep]);
      const sections = sectionize([parent], { maxHeadingDepth: 2 });
      // parent has children → not a loner → emitted; deep folds into parent
      assert.equal(sections.length, 1);
      assert.equal(sections[0].body, '');
    });

    test('over-limit node with over-limit children: all body folds into same in-scope ancestor', () => {
      const gc = node('GC', '> Source: /a#gc', 'GC body.', 4);
      const deep = node('Deep', '> Source: /a#deep', 'Deep body.', 3, [gc]);
      const parent = node('Parent', '> Source: /a', 'Parent body.', 2, [deep]);
      const sections = sectionize([parent], { maxHeadingDepth: 2 });
      assert.equal(sections.length, 1);
      assert.ok(sections[0].body.includes('Parent body.'));
      assert.ok(sections[0].body.includes('Deep body.'));
      assert.ok(sections[0].body.includes('GC body.'));
    });

    test('in-limit child after over-limit sibling still produces its own section', () => {
      const over = node('Over', '> Source: /a#over', 'Over body.', 3);
      const inlimit = node('InLimit', '> Source: /a#inlimit', 'In body.', 2);
      const root = node('Root', '> Source: /a', 'body', 1, [over, inlimit]);
      const sections = sectionize([root], { maxHeadingDepth: 2 });
      assert.equal(sections.length, 2);
      assert.equal(sections[0].heading, '# Root');
      assert.equal(sections[1].heading, '## InLimit');
      assert.ok(sections[0].body.includes('Over body.'));
      assert.ok(sections[1].body.includes('In body.'));
    });

    test('root node with depth > maxHeadingDepth does not crash (targetSection is null for root)', () => {
      const deepRoot = node('Deep Root', '> Source: /docs/a#deep', 'content', 5);
      assert.doesNotThrow(
        () => sectionize([deepRoot], { maxHeadingDepth: 4 }),
        'sectionize must not crash when root node depth exceeds maxHeadingDepth'
      );
    });

    test('root node with depth > maxHeadingDepth: body content is not silently lost', () => {
      const deepRoot = node('Deep Root', '> Source: /docs/a#deep', 'important content', 5);
      let sections;
      try {
        sections = sectionize([deepRoot], { maxHeadingDepth: 4 });
      } catch (_) {
        assert.fail('sectionize threw for root node with depth > maxHeadingDepth');
      }
      const allBody = sections.map(s => s.body).join('\n');
      assert.ok(
        allBody.includes('important content'),
        `content of deep root node lost after sectionize. sections: ${JSON.stringify(sections)}`
      );
    });

    test('node at exactly maxHeadingDepth is emitted, not folded', () => {
      const child = node('Deep', '> Source: /a#d', 'deep body', 3);
      const parent = node('Top', '> Source: /a', 'top body', 1, [child]);
      const sections = sectionize([parent], { maxHeadingDepth: 3 });
      assert.equal(sections.length, 2);
      assert.equal(sections[1].heading, '### Deep');
      assert.ok(sections[1].body.includes('deep body'));
    });

    test('two over-limit siblings both contribute to ancestor body in document order', () => {
      const s1 = node('S1', '> Source: /a#1', 'body one', 3);
      const s2 = node('S2', '> Source: /a#2', 'body two', 3);
      const parent = node('P', '> Source: /a', 'parent body', 1, [s1, s2]);
      const [section] = sectionize([parent], { maxHeadingDepth: 2 });
      assert.equal(section.headingPath[0], 'P');
      const b = section.body;
      const i1 = b.indexOf('body one');
      const i2 = b.indexOf('body two');
      assert.ok(i1 !== -1 && i2 !== -1, 'both bodies must appear');
      assert.ok(i1 < i2, 'S1 body must precede S2 body');
      assert.ok(b.includes('### S1'));
      assert.ok(b.includes('### S2'));
    });

    test('node with empty body gets dropped', () => {
      const deep = node('OnlyHeading', '> Source: /a#h', '', 3);
      const parent = node('P', '> Source: /a', 'parent body', 1, [deep]);
      const [section] = sectionize([parent], { maxHeadingDepth: 2 });
      assert.equal(section.body, 'parent body');
      assert.doesNotMatch(section.body, /###\s+OnlyHeading\n\n\n/);
    });
  });

  describe('referential safety', () => {
    test('sibling headingPath is not polluted by earlier sibling', () => {
      const a = node('A', '> Source: /a', 'a body', 2);
      const b = node('B', '> Source: /b', 'b body', 2);
      const parent = node('Root', '> Source: /r', 'root body', 1, [a, b]);
      const sections = sectionize([parent], {});
      const aSec = sections.find(s => s.heading === '## A');
      const bSec = sections.find(s => s.heading === '## B');
      assert.deepEqual(aSec.headingPath, ['Root', 'A']);
      assert.deepEqual(bSec.headingPath, ['Root', 'B']);
    });
  });
});
