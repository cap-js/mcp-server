import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { filter as filterRaw } from '../../stages/07-filter.js';

const config = { minChunkSize: 100 };
const cfg0   = { minChunkSize: 0 };
const cfg100 = { minChunkSize: 100 };

function filter(chunks, cfg) { return filterRaw(chunks, cfg).outputFilter; }

function chunk(body, source) {
  return { breadcrumb: '', heading: '', source: source ? source : '', body, depth: 1 };
}

function ids(chunks) {
  return chunks.map((c) => c.body);
}

describe('filter', () => {
  describe('basic size and content checks', () => {
    test('empty body chunk is filtered out', () => {
      const result = filter([chunk('')], config);
      assert.equal(result.length, 0);
    });

    test('whitespace-only body is filtered out', () => {
      const result = filter([chunk('   \n\t  \n')], config);
      assert.equal(result.length, 0);
    });

    test('short body with no meaningful content is filtered out', () => {
      const result = filter([chunk('just a few plain words')], config);
      assert.equal(result.length, 0);
    });

    test('short body with inline code is kept', () => {
      const body = 'run `npm install` now';
      const result = filter([chunk(body)], config);
      assert.deepEqual(ids(result), [body]);
    });

    test('short body with a code fence is kept', () => {
      const body = '```\ndoit()\n```';
      const result = filter([chunk(body)], config);
      assert.deepEqual(ids(result), [body]);
    });

    test('short body with a warning marker is kept', () => {
      const body = '**Warning** be careful here';
      const result = filter([chunk(body)], config);
      assert.deepEqual(ids(result), [body]);
    });

    test('body longer than minChunkSize is always kept', () => {
      const body = 'plain filler text '.repeat(10);
      assert.ok(body.trim().length >= config.minChunkSize);
      const result = filter([chunk(body)], config);
      assert.deepEqual(ids(result), [body]);
    });
  });

  describe('anchor-only body', () => {
    test('section with only ######-slug lines is dropped', () => {
      const body = '###### my-anchor\n###### another-anchor';
      assert.equal(filter([chunk(body)], cfg0).length, 0);
    });

    test('single slug line alone is dropped', () => {
      assert.equal(filter([chunk('###### my-anchor')], cfg0).length, 0);
    });

    test('section with real prose after slug lines is kept', () => {
      const body = '###### my-anchor\n\nThis is real prose that follows the anchor and contains useful information.';
      assert.equal(filter([chunk(body)], cfg0).length, 1);
    });
  });

  describe('valueless body — placeholder stubs', () => {
    test('"will come soon" body is dropped', () => {
      assert.equal(filter([chunk('will come soon')], cfg0).length, 0);
    });

    test('"coming soon" body is dropped', () => {
      assert.equal(filter([chunk('coming soon.')], cfg0).length, 0);
    });

    test('"TBD" body is dropped', () => {
      assert.equal(filter([chunk('TBD')], cfg0).length, 0);
    });

    test('"to be written" body is dropped', () => {
      assert.equal(filter([chunk('To be written.')], cfg0).length, 0);
    });

    test('"this documentation is not complete yet" is dropped', () => {
      assert.equal(filter([chunk('This documentation is not complete yet.')], cfg0).length, 0);
    });

    test('real prose is not confused with a placeholder', () => {
      const body = 'This feature is available in version 2.0 and provides connection pooling.';
      assert.equal(filter([chunk(body)], cfg0).length, 1);
    });
  });

  describe('valueless body — sup/sub footnote only', () => {
    test('long body (>=120 chars) containing an inline <sup> is kept', () => {
      const body =
        'This feature enables connection pooling which significantly improves performance ' +
        'under concurrent load<sup>1</sup> — see the benchmarks in the appendix for details.';
      assert.ok(body.length >= 120, `body should be >=120 chars, got ${body.length}`);
      assert.equal(filter([chunk(body)], cfg0).length, 1);
    });
  });

  describe('valueless body — intro-to-table stub', () => {
    test('short prose ending ":" but with a code fence is kept', () => {
      assert.equal(filter([chunk('Run this command:\n\n```sh\nnpm install\n```')], cfg0).length, 1);
    });

    test('short prose ending ":" but with a real external link is kept', () => {
      assert.equal(
        filter([chunk('See [the guide](https://example.com/guide) for details:')], cfg0).length,
        1,
      );
    });

    test('prose longer than 200 chars ending ":" is kept (below stub threshold)', () => {
      const body =
        'This section describes the configuration properties that control the behaviour ' +
        'of the connection pool in production environments, the thread model, and all ' +
        'relevant tuning parameters as documented in the official specification:';
      assert.ok(body.trim().length >= 200, `body too short: ${body.trim().length}`);
      assert.equal(filter([chunk(body)], cfg0).length, 1);
    });
  });

  describe('valueless body — stripped residue is empty', () => {
    test('body of only an image is dropped', () => {
      assert.equal(filter([chunk('![alt text](https://example.com/img.png)')], cfg0).length, 0);
    });

    test('body of only HTML tags is dropped', () => {
      assert.equal(filter([chunk('<UnderConstruction/>')], cfg0).length, 0);
    });

    test('body of only {.class} markers is dropped', () => {
      assert.equal(filter([chunk('{.subtitle}\n{.lead}')], cfg0).length, 0);
    });

    test('body with image AND real prose is kept', () => {
      assert.equal(
        filter([chunk('![diagram](https://example.com/d.png)\n\nThis diagram shows the architecture.')], cfg0).length,
        1,
      );
    });
  });

  describe('redirect-stub — no fold target', () => {
    test('single link with no prose is dropped', () => {
      assert.equal(filter([chunk('[CQN](/docs/cds/cqn)')], cfg0).length, 0);
    });

    test('single link preceded only by "See" and a period is NOT a redirect-stub (has prose)', () => {
      assert.equal(filter([chunk('See [CQN](/docs/cds/cqn).')], cfg0).length, 1);
    });

    test('single link with surrounding prose is kept', () => {
      assert.equal(
        filter([chunk('CQN is the query notation used throughout CAP. See [CQN](/docs/cds/cqn) for full reference.')], cfg0).length,
        1,
      );
    });

    test('multiple links body is kept', () => {
      assert.equal(
        filter([chunk('See [A](/docs/a) and [B](/docs/b) for details.')], cfg0).length,
        1,
      );
    });

    test('link inside a list is not a redirect-stub', () => {
      assert.equal(
        filter([chunk('- [CQN](/docs/cds/cqn)\n- [CSN](/docs/cds/csn)')], cfg0).length,
        1,
      );
    });

    test('body with code fence and a link is not a redirect-stub', () => {
      assert.equal(
        filter([chunk('See [guide](/docs/guide).\n\n```js\nconst x = 1\n```')], cfg0).length,
        1,
      );
    });

    test('"As in" link is not a redirect-stub', () => {
      assert.equal(
        filter([chunk('[As in SELECT.where](/docs/node.js/cds-ql#select-where)')], cfg0).length,
        1,
      );
    });
  });

  describe('landing-stub', () => {
    const landingSrc = '> Source: https://cap.cloud.sap/docs/guides/';

    test('short tagline body on a trailing-slash URL is dropped', () => {
      assert.equal(filter([chunk('Welcome to the guides section.', landingSrc)], cfg100).length, 0);
    });

    test('body with a code fence on trailing-slash URL is kept', () => {
      assert.equal(
        filter([chunk('Install:\n\n```sh\nnpm install\n```', landingSrc)], cfg100).length,
        1,
      );
    });

    test('body with a list on trailing-slash URL is kept', () => {
      assert.equal(
        filter([chunk('Topics:\n\n- Item one\n- Item two\n- Item three', landingSrc)], cfg100).length,
        1,
      );
    });

    test('body with a table on trailing-slash URL is kept', () => {
      assert.equal(
        filter([chunk('| Option | Value |\n|--------|-------|\n| a | b |', landingSrc)], cfg100).length,
        1,
      );
    });

    test('body with a real link on trailing-slash URL is kept', () => {
      assert.equal(
        filter([chunk('See [reference](https://cap.cloud.sap/docs/cds/cqn).', landingSrc)], cfg100).length,
        1,
      );
    });

    test('body longer than minChunkSize on trailing-slash URL is kept', () => {
      const body = 'This guide section covers many topics in detail. '.repeat(3);
      assert.ok(body.length >= cfg100.minChunkSize);
      assert.equal(filter([chunk(body, landingSrc)], cfg100).length, 1);
    });
  });

  describe('body-hash dedup', () => {
    test('exact duplicate body under a second source anchor is dropped', () => {
      const prose =
        'This is the exact same prose content appearing under two different section anchors on the same page.';
      const c1 = { ...chunk(prose), source: '> Source: https://cap.cloud.sap/docs/guides/page#a' };
      const c2 = { ...chunk(prose), source: '> Source: https://cap.cloud.sap/docs/guides/page#b' };
      const result = filter([c1, c2], cfg0);
      assert.equal(result.length, 1);
      assert.equal(result[0].source, '> Source: https://cap.cloud.sap/docs/guides/page#a');
    });

    test('two chunks with distinct bodies are both kept', () => {
      const c1 = chunk('Connection pooling reuses open database connections to avoid per-request handshake overhead.');
      const c2 = chunk('Lazy loading defers entity resolution until the association is first accessed at runtime.');
      assert.equal(filter([c1, c2], cfg0).length, 2);
    });

    test('dedup ignores heading — same prose under different headings is deduplicated', () => {
      const prose = 'Same prose body text that is repeated verbatim under two different anchor headings on the page.';
      const c1 = { ...chunk(prose), source: '> Source: https://cap.cloud.sap/docs/page#one' };
      const c2 = { ...chunk(prose), source: '> Source: https://cap.cloud.sap/docs/page#two' };
      assert.equal(filter([c1, c2], cfg0).length, 1);
    });
  });

  describe('releases category', () => {
    test('chunk from /docs/releases/ is dropped', () => {
      const src = '> Source: https://cap.cloud.sap/docs/releases/2024-01';
      assert.equal(
        filter([chunk('New feature added in this release with detailed description.', src)], cfg0).length,
        0,
      );
    });

    test('chunk from /docs/guides/ is not affected by releases filter', () => {
      const src = '> Source: https://cap.cloud.sap/docs/guides/services';
      assert.equal(
        filter([chunk('Services define the API surface of a CAP application exposed to consumers.')], cfg0).length,
        1,
      );
    });
  });

  describe('flowchart gap-fills', () => {
    test('chunk in /docs/releases/ with empty body drops as releases, not emptyBody', () => {
      const c = chunk('', '> Source: /docs/releases/2025-01');
      const { dropped } = filterRaw([c], cfg0);
      assert.equal(dropped.releases.length, 1, 'must be classified as releases');
      assert.equal(dropped.emptyBody.length, 0, 'must NOT reach emptyBody bucket');
    });

    test('chunk with undefined source does not crash and goes past releases check', () => {
      const c = { breadcrumb: '', heading: '', body: 'real prose content that easily exceeds minChunkSize threshold set at one hundred.' };
      const { outputFilter, dropped } = filterRaw([c], cfg0);
      assert.equal(dropped.releases.length, 0);
      assert.equal(outputFilter.length, 1);
    });

    test('source without /docs/ prefix is not a release', () => {
      const c = chunk('some real prose content in the body', '> Source: ./relative.md');
      const { dropped } = filterRaw([c], cfg0);
      assert.equal(dropped.releases.length, 0);
    });

    test('body with placeholder text plus a code fence is kept (fence bailout)', () => {
      const body = 'tbd\n```js\nsome real code\n```';
      const result = filter([chunk(body)], cfg0);
      assert.equal(result.length, 1);
    });

    test('body mixing # (depth 1) with #### slug is NOT anchor-only', () => {
      const body = '# Real Heading\n#### slug-1\n\nSome real prose that easily crosses the min size threshold in this test.';
      const { outputFilter, dropped } = filterRaw([chunk(body)], cfg0);
      assert.equal(dropped.anchorOnlyBody.length, 0);
      assert.equal(outputFilter.length, 1);
    });

    test('three chunks with identical bodies: one kept, two dropped as duplicates', () => {
      const c1 = chunk('same body content large enough to survive size checks in this test file');
      const c2 = chunk('same body content large enough to survive size checks in this test file');
      const c3 = chunk('same body content large enough to survive size checks in this test file');
      const { outputFilter, dropped } = filterRaw([c1, c2, c3], cfg0);
      assert.equal(outputFilter.length, 1, 'exactly one kept');
      assert.equal(dropped.duplicates.length, 2, 'other two go to duplicates bucket');
    });

    test('dedup treats bodies as identical if they only differ by trailing whitespace', () => {
      const long = 'some real prose that easily crosses the min size threshold in the filter test';
      const c1 = chunk(long);
      const c2 = chunk(long + '\n\n  ');
      const { outputFilter, dropped } = filterRaw([c1, c2], cfg0);
      assert.equal(outputFilter.length, 1);
      assert.equal(dropped.duplicates.length, 1);
    });
  });
});
