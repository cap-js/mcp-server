import { it, describe } from 'node:test'
import assert from 'node:assert'
import { filter as filterRaw } from '../../../lib/markdownEmbeddings/chunker/stages/08-filter.js'

// A deterministic one-character-per-token measure for these unit fixtures.
const measure = (text) => text.length
const config = { minTokens: 100, measure }
const cfg0 = { minTokens: 0, measure }
const cfg100 = { minTokens: 100, measure }

function filter(chunks, cfg) {
  return filterRaw(chunks, cfg).outputFilter
}

function chunk(body, source) {
  return {
    breadcrumb: '',
    heading: '',
    source: source ? source : '',
    displayBody: body,
    embeddingBody: body,
    depth: 1
  }
}

function ids(chunks) {
  return chunks.map((c) => c.displayBody)
}

describe('filter', () => {
  describe('when checking size and content', () => {
    it('should filter out a chunk with an empty body', () => {
      const result = filter([chunk('')], config)
      assert.strictEqual(result.length, 0)
    })

    it('should filter out a body that contains only whitespace', () => {
      const result = filter([chunk('   \n\t  \n')], config)
      assert.strictEqual(result.length, 0)
    })

    it('should filter out a short body with no meaningful content', () => {
      const result = filter([chunk('just a few plain words')], config)
      assert.strictEqual(result.length, 0)
    })

    it('should drop a body below minTokens even when it contains inline code', () => {
      const body = 'run `npm install` now'
      const result = filter([chunk(body)], config)
      assert.strictEqual(result.length, 0)
    })

    it('should drop a body below minTokens even when it contains a code fence', () => {
      const body = '```\ndoit()\n```'
      const result = filter([chunk(body)], config)
      assert.strictEqual(result.length, 0)
    })

    it('should drop a body below minTokens even when it contains a warning marker', () => {
      const body = '**Warning** be careful here'
      const result = filter([chunk(body)], config)
      assert.strictEqual(result.length, 0)
    })

    it('should keep a body above minTokens', () => {
      const body = 'plain filler text '.repeat(10)
      assert.ok(measure(body.trim()) >= config.minTokens)
      const result = filter([chunk(body)], config)
      assert.deepStrictEqual(ids(result), [body])
    })
  })

  describe('when the body contains only anchors', () => {
    it('should drop a section with only ######-slug lines', () => {
      const body = '###### my-anchor\n###### another-anchor'
      assert.strictEqual(filter([chunk(body)], cfg0).length, 0)
    })

    it('should drop a single slug line standing alone', () => {
      assert.strictEqual(filter([chunk('###### my-anchor')], cfg0).length, 0)
    })

    it('should keep a section that has real prose after slug lines', () => {
      const body =
        '###### my-anchor\n\nThis is real prose that follows the anchor and contains useful information.'
      assert.strictEqual(filter([chunk(body)], cfg0).length, 1)
    })
  })

  describe('when the body is a placeholder stub', () => {
    it('should drop a body containing only "will come soon"', () => {
      assert.strictEqual(filter([chunk('will come soon')], cfg0).length, 0)
    })

    it('should drop a body containing only "coming soon"', () => {
      assert.strictEqual(filter([chunk('coming soon.')], cfg0).length, 0)
    })

    it('should drop a body containing only "TBD"', () => {
      assert.strictEqual(filter([chunk('TBD')], cfg0).length, 0)
    })

    it('should drop a body containing only "to be written"', () => {
      assert.strictEqual(filter([chunk('To be written.')], cfg0).length, 0)
    })

    it('should drop a body containing only "this documentation is not complete yet"', () => {
      assert.strictEqual(filter([chunk('This documentation is not complete yet.')], cfg0).length, 0)
    })

    it('should not confuse real prose with a placeholder', () => {
      const body = 'This feature is available in version 2.0 and provides connection pooling.'
      assert.strictEqual(filter([chunk(body)], cfg0).length, 1)
    })
  })

  describe('when the body contains only a sup/sub footnote', () => {
    it('should keep a long body (>=120 chars) containing an inline <sup>', () => {
      const body =
        'This feature enables connection pooling which significantly improves performance ' +
        'under concurrent load<sup>1</sup> — see the benchmarks in the appendix for details.'
      assert.ok(body.length >= 120, `body should be >=120 chars, got ${body.length}`)
      assert.strictEqual(filter([chunk(body)], cfg0).length, 1)
    })
  })

  describe('when the body is an intro-to-table stub', () => {
    it('should keep short prose ending ":" when it contains a code fence', () => {
      assert.strictEqual(
        filter([chunk('Run this command:\n\n```sh\nnpm install\n```')], cfg0).length,
        1
      )
    })

    it('should keep short prose ending ":" when it contains a real external link', () => {
      assert.strictEqual(
        filter([chunk('See [the guide](https://example.com/guide) for details:')], cfg0).length,
        1
      )
    })

    it('should keep prose longer than 200 chars ending ":" (below stub threshold)', () => {
      const body =
        'This section describes the configuration properties that control the behaviour ' +
        'of the connection pool in production environments, the thread model, and all ' +
        'relevant tuning parameters as documented in the official specification:'
      assert.ok(body.trim().length >= 200, `body too short: ${body.trim().length}`)
      assert.strictEqual(filter([chunk(body)], cfg0).length, 1)
    })
  })

  describe('when the stripped body residue is empty', () => {
    it('should drop a body that holds only an image', () => {
      assert.strictEqual(
        filter([chunk('![alt text](https://example.com/img.png)')], cfg0).length,
        0
      )
    })

    it('should drop a body that holds only HTML tags', () => {
      assert.strictEqual(filter([chunk('<UnderConstruction/>')], cfg0).length, 0)
    })

    it('should drop a body that holds only {.class} markers', () => {
      assert.strictEqual(filter([chunk('{.subtitle}\n{.lead}')], cfg0).length, 0)
    })

    it('should keep a body that has an image AND real prose', () => {
      assert.strictEqual(
        filter(
          [chunk('![diagram](https://example.com/d.png)\n\nThis diagram shows the architecture.')],
          cfg0
        ).length,
        1
      )
    })
  })

  describe('when the body is a redirect stub with no fold target', () => {
    it('should drop a single link body with no prose', () => {
      assert.strictEqual(filter([chunk('[CQN](/docs/cds/cqn)')], cfg0).length, 0)
    })

    it('should keep a single link preceded only by "See" and a period (has prose, not a redirect-stub)', () => {
      assert.strictEqual(filter([chunk('See [CQN](/docs/cds/cqn).')], cfg0).length, 1)
    })

    it('should keep a single link with surrounding prose', () => {
      assert.strictEqual(
        filter(
          [
            chunk(
              'CQN is the query notation used throughout CAP. See [CQN](/docs/cds/cqn) for full reference.'
            )
          ],
          cfg0
        ).length,
        1
      )
    })

    it('should keep a body with multiple links', () => {
      assert.strictEqual(
        filter([chunk('See [A](/docs/a) and [B](/docs/b) for details.')], cfg0).length,
        1
      )
    })

    it('should keep a link inside a list (not a redirect-stub)', () => {
      assert.strictEqual(
        filter([chunk('- [CQN](/docs/cds/cqn)\n- [CSN](/docs/cds/csn)')], cfg0).length,
        1
      )
    })

    it('should keep a body with a code fence and a link (not a redirect-stub)', () => {
      assert.strictEqual(
        filter([chunk('See [guide](/docs/guide).\n\n```js\nconst x = 1\n```')], cfg0).length,
        1
      )
    })

    it('should keep an "As in" link (not a redirect-stub)', () => {
      assert.strictEqual(
        filter([chunk('[As in SELECT.where](/docs/node.js/cds-ql#select-where)')], cfg0).length,
        1
      )
    })
  })

  describe('when the body is a landing stub', () => {
    const landingSrc = '> Source: https://cap.cloud.sap/docs/guides/'

    it('should drop a short tagline body on a trailing-slash URL', () => {
      assert.strictEqual(
        filter([chunk('Welcome to the guides section.', landingSrc)], cfg100).length,
        0
      )
    })

    it('should drop a body below minTokens with a code fence on a trailing-slash URL', () => {
      assert.strictEqual(
        filter([chunk('Install:\n\n```sh\nnpm install\n```', landingSrc)], cfg100).length,
        0
      )
    })

    it('should drop a body below minTokens with a list on a trailing-slash URL', () => {
      assert.strictEqual(
        filter([chunk('Topics:\n\n- Item one\n- Item two\n- Item three', landingSrc)], cfg100)
          .length,
        0
      )
    })

    it('should drop a body below minTokens with a table on a trailing-slash URL', () => {
      assert.strictEqual(
        filter([chunk('| Option | Value |\n|--------|-------|\n| a | b |', landingSrc)], cfg100)
          .length,
        0
      )
    })

    it('should drop a body below minTokens with a real link on a trailing-slash URL', () => {
      assert.strictEqual(
        filter([chunk('See [reference](https://cap.cloud.sap/docs/cds/cqn).', landingSrc)], cfg100)
          .length,
        0
      )
    })

    it('should keep a body above minTokens on a trailing-slash URL', () => {
      const body = 'This guide section covers many topics in detail. '.repeat(3)
      assert.ok(measure(body.trim()) >= cfg100.minTokens)
      assert.strictEqual(filter([chunk(body, landingSrc)], cfg100).length, 1)
    })
  })

  describe('when deduplicating by body hash', () => {
    it('should drop an exact duplicate body under a second source anchor', () => {
      const prose =
        'This is the exact same prose content appearing under two different section anchors on the same page.'
      const c1 = {
        ...chunk(prose),
        source: '> Source: https://cap.cloud.sap/docs/guides/page#a'
      }
      const c2 = {
        ...chunk(prose),
        source: '> Source: https://cap.cloud.sap/docs/guides/page#b'
      }
      const result = filter([c1, c2], cfg0)
      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0].source, '> Source: https://cap.cloud.sap/docs/guides/page#a')
    })

    it('should keep two chunks with distinct bodies', () => {
      const c1 = chunk(
        'Connection pooling reuses open database connections to avoid per-request handshake overhead.'
      )
      const c2 = chunk(
        'Lazy loading defers entity resolution until the association is first accessed at runtime.'
      )
      assert.strictEqual(filter([c1, c2], cfg0).length, 2)
    })

    it('should deduplicate same prose under different headings (heading is ignored)', () => {
      const prose =
        'Same prose body text that is repeated verbatim under two different anchor headings on the page.'
      const c1 = {
        ...chunk(prose),
        source: '> Source: https://cap.cloud.sap/docs/page#one'
      }
      const c2 = {
        ...chunk(prose),
        source: '> Source: https://cap.cloud.sap/docs/page#two'
      }
      assert.strictEqual(filter([c1, c2], cfg0).length, 1)
    })
  })

  describe('when filtering the releases category', () => {
    it('should drop a chunk from /docs/releases/', () => {
      const src = '> Source: https://cap.cloud.sap/docs/releases/2024-01'
      assert.strictEqual(
        filter([chunk('New feature added in this release with detailed description.', src)], cfg0)
          .length,
        0
      )
    })

    it('should not drop a chunk from /docs/guides/ via the releases filter', () => {
      assert.strictEqual(
        filter(
          [chunk('Services define the API surface of a CAP application exposed to consumers.')],
          cfg0
        ).length,
        1
      )
    })
  })

  describe('when filling flowchart gaps', () => {
    it('should classify a /docs/releases/ chunk with empty body as releases, not emptyBody', () => {
      const c = chunk('', '> Source: /docs/releases/2025-01')
      const { dropped } = filterRaw([c], cfg0)
      assert.strictEqual(dropped.releases.length, 1, 'must be classified as releases')
      assert.strictEqual(dropped.emptyBody.length, 0, 'must NOT reach emptyBody bucket')
    })

    it('should not crash when a chunk has undefined source and pass it past the releases check', () => {
      const c = chunk('real prose content that easily exceeds the configured minimum token count.')
      delete c.source
      const { outputFilter, dropped } = filterRaw([c], cfg0)
      assert.strictEqual(dropped.releases.length, 0)
      assert.strictEqual(outputFilter.length, 1)
    })

    it('should not classify a source without /docs/ prefix as a release', () => {
      const c = chunk('some real prose content in the body', '> Source: ./relative.md')
      const { dropped } = filterRaw([c], cfg0)
      assert.strictEqual(dropped.releases.length, 0)
    })

    it('should keep a body with placeholder text when a code fence is present (fence bailout)', () => {
      const body = 'tbd\n```js\nsome real code\n```'
      const result = filter([chunk(body)], cfg0)
      assert.strictEqual(result.length, 1)
    })

    it('should not classify a body mixing # (depth 1) with #### slug as anchor-only', () => {
      const body =
        '# Real Heading\n#### slug-1\n\nSome real prose that easily crosses the min size threshold in this test.'
      const { outputFilter, dropped } = filterRaw([chunk(body)], cfg0)
      assert.strictEqual(dropped.anchorOnlyBody.length, 0)
      assert.strictEqual(outputFilter.length, 1)
    })

    it('should keep one chunk and drop the other two when three chunks have identical bodies', () => {
      const c1 = chunk('same body content large enough to survive size checks in this test file')
      const c2 = chunk('same body content large enough to survive size checks in this test file')
      const c3 = chunk('same body content large enough to survive size checks in this test file')
      const { outputFilter, dropped } = filterRaw([c1, c2, c3], cfg0)
      assert.strictEqual(outputFilter.length, 1, 'exactly one kept')
      assert.strictEqual(dropped.duplicates.length, 2, 'other two go to duplicates bucket')
    })

    it('should treat bodies as identical when they differ only by trailing whitespace', () => {
      const long = 'some real prose that easily crosses the min size threshold in the filter test'
      const c1 = chunk(long)
      const c2 = chunk(long + '\n\n  ')
      const { outputFilter, dropped } = filterRaw([c1, c2], cfg0)
      assert.strictEqual(outputFilter.length, 1)
      assert.strictEqual(dropped.duplicates.length, 1)
    })
  })
})
