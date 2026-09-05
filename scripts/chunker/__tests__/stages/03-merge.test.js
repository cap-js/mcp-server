import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSections } from '../../stages/03-mergeSections.js';

const cfg = { maxChunkSize: 1000, minChunkSize: 100 };

function sec(body, overrides = {}) {
  return { heading: 'H', headingPath: ['H'], source: '', depth: 1, body, ...overrides };
}

describe('mergeSections', () => {
  describe('trivial inputs', () => {
    test('empty array returns empty array', () => {
      assert.deepEqual(mergeSections([], cfg), []);
    });

    test('single section passes through unchanged', () => {
      const s = sec('Hello world.');
      assert.deepEqual(mergeSections([s], cfg), [s]);
    });

    test('no merge when both sections have body', () => {
      const a = sec('First section.');
      const b = sec('Second section.');
      assert.equal(mergeSections([a, b], cfg).length, 2);
    });
  });

  describe('empty-body absorption', () => {
    test('empty-body section followed by non-empty same-depth section is absorbed', () => {
      const empty = sec('', { depth: 2, heading: '## A' });
      const full  = sec('Content here.', { depth: 2, heading: '## B' });
      const result = mergeSections([empty, full], cfg);
      assert.equal(result.length, 1);
      assert.ok(result[0].body.includes('Content here.'));
      assert.ok(result[0].heading.includes('## B'));
    });

    test('empty-body absorption works at depth 1 (no depth restriction)', () => {
      const empty = sec('', { depth: 1, heading: '# A' });
      const full  = sec('Content.', { depth: 1, heading: '# B' });
      const result = mergeSections([empty, full], cfg);
      assert.equal(result.length, 1);
      assert.ok(result[0].body.includes('Content.'));
    });

    test('empty-body section followed by deeper section is NOT absorbed', () => {
      const empty  = sec('', { depth: 2, heading: '## A' });
      const deeper = sec('Child content.', { depth: 3, heading: '### B' });
      const result = mergeSections([empty, deeper], cfg);
      assert.equal(result.length, 2);
    });

    test('multiple consecutive empty-body sections all absorbed into next non-empty', () => {
      const e1   = sec('', { depth: 2, heading: '## A' });
      const e2   = sec('', { depth: 2, heading: '## B' });
      const e3   = sec('', { depth: 2, heading: '## C' });
      const full = sec('Final content.', { depth: 2, heading: '## D' });
      const result = mergeSections([e1, e2, e3, full], cfg);
      assert.equal(result.length, 1);
      const chunk = result[0];
      assert.ok(chunk.body.includes('Final content.'));
      assert.ok(chunk.heading.includes('## A'));
      assert.ok(chunk.heading.includes('## B'));
      assert.ok(chunk.heading.includes('## C'));
      assert.ok(chunk.heading.includes('## D'));
    });

    test('absorbed section identity is target section', () => {
      const empty = sec('', { depth: 2, heading: '## First', headingPath: ['First'] });
      const full  = sec('Body.', { depth: 2, heading: '## Second', headingPath: ['Second'] });
      const result = mergeSections([empty, full], cfg);
      assert.equal(result[0].heading, '## First\n## Second');
      assert.deepEqual(result[0].headingPath, ['Second']);
    });

    test('empty-body absorption fires without anaphoric word (general rule)', () => {
      // Previously required anaphoric word; now any non-empty next section triggers it
      const empty = sec('', { depth: 2, heading: '## A' });
      const full  = sec('Just a regular sentence.', { depth: 2, heading: '## B' });
      const result = mergeSections([empty, full], cfg);
      assert.equal(result.length, 1, 'should merge even without anaphoric word');
    });

    test('merged child into child2 without touching surrounding chunks', () => {
      const parent = {
        heading: '## Config', headingPath: ['Root', 'Config'],
        source: '> Source: /docs/a#config', depth: 2,
        body: '',
      };
      const child = {
        heading: '### Option A', headingPath: ['Root', 'Config', 'Option A'],
        source: '> Source: /docs/a#option-a', depth: 3,
        body: '',
      };
      const child2 = {
        heading: '### Option B', headingPath: ['Root', 'Config', 'Option B'],
        source: '> Source: /docs/a#option-b', depth: 3,
        body: '',
      };
      const child3 = {
        heading: '### Option C', headingPath: ['Root', 'Config', 'Option C'],
        source: '> Source: /docs/a#option-c', depth: 3,
        body: 'Set `option_a = true` in the config file.',
      };
      const grandchild = {
        heading: '#### Option Grandchild', headingPath: ['Root', 'Config', 'Option A', 'Option Grandchild'],
        source: '> Source: /docs/a#option-grandchild', depth: 4,
        body: '',
      };
      const result = mergeSections([parent, child, child2, child3, grandchild], cfg);
      assert.equal(result.length, 3);
      assert.equal(parent, result[0]);
      assert.equal(grandchild, result[2]);
      assert.deepEqual(result[1], {
        ...child3, heading: '### Option A\n### Option B\n### Option C'
      });
    });
  });
});
