import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runPipeline } from '../../lib/markdownEmbeddings/chunker/chunkMarkdown.js'
import { capireChunkerAdapter } from '../../lib/markdownEmbeddings/adapters/capire/capireAdapter.js'

const config = {
  source: 'guide.md',
  minTokens: 0,
  maxHeadingDepth: 5,
  maxTokens: 64,
  measure: (text) => Math.ceil(text.length / 4)
}

describe('generic Markdown chunking pipeline', () => {
  describe('when extending stage execution', () => {
    it('should apply wrapper logic before and after the default transformation', () => {
      const adapter = {
        wrap: {
          transformBlocks: (next) => (context) => {
            context.blocks[0].text = 'Replacement body.'
            next(context)
            context.heading = '# Replaced heading'
          }
        }
      }

      const { sections } = runPipeline('# Original\n\nOriginal body.', { ...config, adapter })

      assert.equal(sections.length, 1)
      assert.equal(sections[0].heading, '# Replaced heading')
      assert.equal(sections[0].displayBody, 'Replacement body.')
    })

    it('should execute inserted stages in registration order at each scoped boundary', () => {
      const calls = []
      const stage = (id, placement) => ({
        id,
        ...placement,
        run() {
          calls.push(id)
        }
      })
      const adapter = {
        insert: [
          stage('prepare', { before: 'parseMarkdown' }),
          stage('first', { after: 'parseBlocks' }),
          stage('second', { after: 'parseBlocks' }),
          stage('beforePack', { before: 'packBlocks' }),
          stage('afterPack', { after: 'packBlocks' }),
          stage('finish', { before: 'filterChunks' })
        ]
      }

      runPipeline('# First\n\nFirst body.\n\n# Second\n\nSecond body.', { ...config, adapter })

      assert.deepEqual(calls, [
        'prepare',
        'first',
        'second',
        'beforePack',
        'afterPack',
        'first',
        'second',
        'beforePack',
        'afterPack',
        'finish'
      ])
    })

    it('should preserve document, section, partition and fragment metadata without modifying caller data', () => {
      const metadata = { nested: { owner: 'caller' }, shared: 'document' }
      const adapter = {
        insert: [
          {
            id: 'annotateSection',
            after: 'parseBlocks',
            run(context) {
              context.metadata.section = true
            }
          }
        ],
        wrap: {
          partitionBlocks: (next) => (context) => {
            next(context)
            context.partitions[0].metadata = { shared: 'partition', variant: 'selected' }
          },
          packBlocks: (next) => (context) => {
            next(context)
            context.metadata.nested.owner = 'pipeline'
            for (const fragment of context.fragments) fragment.metadata = { fragment: true }
          }
        }
      }

      const { sections } = runPipeline('# Root\n\n' + 'A sentence with content. '.repeat(20), {
        ...config,
        adapter,
        metadata
      })

      assert.ok(sections.length > 1)
      for (const section of sections) {
        assert.equal(section.metadata.shared, 'partition')
        assert.equal(section.metadata.section, true)
        assert.equal(section.metadata.variant, 'selected')
        assert.equal(section.metadata.fragment, true)
        assert.equal(section.metadata.nested.owner, 'pipeline')
      }
      sections[0].metadata.nested.owner = 'first fragment'
      assert.equal(sections[1].metadata.nested.owner, 'pipeline')
      assert.equal(metadata.nested.owner, 'caller')
    })

    it('should reject invalid extensions before processing the document', () => {
      const noop = () => {}
      const cases = [
        [
          { insert: [{ id: 'parseBlocks', before: 'packBlocks', run: noop }] },
          /duplicate stage ID/
        ],
        [
          { insert: [{ id: 'custom', before: 'missing', run: noop }] },
          /Unknown stage anchor/
        ],
        [
          {
            insert: [
              {
                id: 'custom',
                before: 'parseBlocks',
                after: 'packBlocks',
                run: noop
              }
            ]
          },
          /exactly one/
        ],
        [{ wrap: { missing: () => noop } }, /Unknown wrapped stage/],
        [{ wrap: { validateChunks: () => noop } }, /Unknown wrapped stage/],
        [
          { insert: [{ id: 'custom', after: 'validateChunks', run: noop }] },
          /Unknown stage anchor/
        ],
        [
          {
            insert: [
              { id: 'first', after: 'second', run: noop },
              { id: 'second', after: 'parseBlocks', run: noop }
            ]
          },
          /Unknown stage anchor/
        ]
      ]
      for (const [adapter, message] of cases) {
        let started = false

        assert.throws(
          () =>
            runPipeline('# Root\n\nContent.', {
              ...config,
              adapter: {
                ...adapter,
                insert: [
                  { id: 'observeStart', before: 'parseMarkdown', run() { started = true } },
                  ...(adapter.insert ?? [])
                ]
              }
            }),
          message
        )

        assert.equal(started, false)
      }
    })

    it('should enforce the final budget even after a custom post-packing stage', () => {
      const adapter = {
        insert: [
          {
            id: 'oversize',
            after: 'packBlocks',
            run(context) {
              context.fragments[0].embeddingBody = 'x'.repeat(1000)
            }
          }
        ]
      }

      assert.throws(
        () => runPipeline('# Root\n\nContent.', { ...config, adapter }),
        /chunkMarkdown:validateChunks.*failed validation/
      )
    })

    it('should include stage and section identity when an extension fails', () => {
      const cause = new Error('Enrichment failed')
      const adapter = {
        insert: [
          {
            id: 'enrich',
            after: 'transformBlocks',
            run() {
              throw cause
            }
          }
        ]
      }

      assert.throws(
        () => runPipeline('# Root\n\nContent.', { ...config, adapter }),
        (error) => {
          assert.match(error.message, /chunkMarkdown:enrich.*# Root.*Enrichment failed/)
          assert.equal(error.cause, cause)
          return true
        }
      )
    })

    it('should reject promise-returning stages instead of silently completing', () => {
      const adapter = {
        insert: [
          {
            id: 'asyncEnrich',
            after: 'transformBlocks',
            run() {
              return Promise.resolve()
            }
          }
        ]
      }

      assert.throws(
        () => runPipeline('# Root\n\nContent.', { ...config, adapter }),
        /asyncEnrich.*returned a promise/
      )
    })

    it('should detect a promise from next even when a wrapper discards its return value', () => {
      const adapter = {
        insert: [{
          id: 'asyncEnrich',
          after: 'transformBlocks',
          run() { return Promise.resolve() }
        }],
        wrap: {
          asyncEnrich: (next) => (context) => { next(context) }
        }
      }

      assert.throws(
        () => runPipeline('# Root\n\nContent.', { ...config, adapter }),
        /asyncEnrich.*returned a promise/
      )
    })

    it('should keep invocations isolated when reusing an adapter', () => {
      const adapter = {
        insert: [
          {
            id: 'annotate',
            after: 'transformBlocks',
            run(context) {
              context.metadata.input = context.document.text
            }
          }
        ]
      }

      const first = runPipeline('# First\n\nFirst body.', { ...config, adapter })
      const second = runPipeline('# Second\n\nSecond body.', { ...config, adapter })

      assert.equal(first.sections.length, 1)
      assert.equal(second.sections.length, 1)
      assert.equal(first.sections[0].metadata.input, '# First\n\nFirst body.')
      assert.equal(second.sections[0].metadata.input, '# Second\n\nSecond body.')
    })

    it('should anchor to an already registered insertion and wrap inserted stages', () => {
      const calls = []
      const adapter = {
        insert: [
          {
            id: 'later',
            after: 'transformBlocks',
            run() {
              calls.push('later')
            }
          },
          {
            id: 'earlier',
            before: 'later',
            run() {
              calls.push('earlier')
            }
          }
        ],
        wrap: {
          later: (next) => (context) => {
            next(context)
            calls.push('wrapped')
          }
        }
      }

      runPipeline('# Root\n\nContent.', { ...config, adapter })

      assert.deepEqual(calls, ['earlier', 'later', 'wrapped'])
    })

    it('should omit a skipped section while continuing with later sections', () => {
      const adapter = {
        insert: [
          {
            id: 'select',
            before: 'parseBlocks',
            run(context) {
              context.skip = context.section.heading === '# Omitted'
            }
          }
        ]
      }

      const { sections } = runPipeline('# Omitted\n\nFirst body.\n\n# Retained\n\nSecond body.', {
        ...config,
        adapter
      })

      assert.equal(sections.length, 1)
      assert.equal(sections[0].heading, '# Retained')
    })

    it('should use the same effective token budget in packing and validation', () => {
      const adapter = { parseOptions: { maxTokens: 12 } }

      const { sections } = runPipeline('# Root\n\n' + 'A detailed sentence. '.repeat(20), {
        ...config,
        adapter
      })

      assert.ok(sections.length > 1)
      for (const chunk of sections) assert.ok(config.measure(chunk.embeddingBody) <= 12)
    })

    it('should keep chunk output identical when debug snapshots are disabled', () => {
      const text = '# Root\n\nContent.'

      const debug = runPipeline(text, config)
      const lean = runPipeline(text, { ...config, debug: false })

      assert.deepEqual(lean.sections, debug.sections)
      assert.equal(debug.outputParseBlocks.length, 1)
      assert.equal(lean.outputParseBlocks.length, 0)
    })
  })

  describe('with the CAPire adapter', () => {
    it('should apply registered source patches before Markdown parsing', () => {
      let patched
      const adapter = {
        ...capireChunkerAdapter,
        insert: [
          ...capireChunkerAdapter.insert,
          {
            id: 'inspectPatch',
            after: 'patchCapireDocument',
            run(document) {
              patched = document.text
            }
          }
        ]
      }
      const text =
        '# Root\n> Source: /docs/root\n\nConvert into CDS data:\n\n:: code-group\n\nExample content.\n:::'

      runPipeline(text, { ...config, adapter })

      assert.match(patched, /into CDS data:\n\n::: code-group\n/)
    })
    it('should preserve runtime labels and CAP sources while excluding release chunks', () => {
      const text = [
        '# Root',
        '> Source: /docs/root',
        '',
        '<div class="impl java">',
        '',
        'Detailed runtime instructions.',
        '',
        '</div>',
        '',
        '# Release',
        '> Source: /docs/releases/example',
        '',
        'Release content.'
      ].join('\n')

      const result = runPipeline(text, { ...config, adapter: capireChunkerAdapter })

      assert.equal(result.sections.length, 1)
      assert.equal(result.sections[0].source, 'https://cap.cloud.sap/docs/root')
      assert.equal(result.sections[0].label, 'java')
      assert.match(result.sections[0].embeddingBody, /^Java:/)
      assert.equal(result.dropped.filterDropped.releases.length, 1)
    })
  })
  it('should retain headings and caller-provided document metadata', () => {
    const { sections } = runPipeline(
      '# Guide\n\nOverview.\n\n## Setup\n\nInstallation steps.',
      config
    )

    assert.equal(sections.length, 2)
    assert.equal(sections[0].source, 'guide.md')
    assert.equal(sections[1].breadcrumb, 'Guide')
    assert.equal(sections[1].heading, '## Setup')
  })

  it('should retain headingless content in a document section', () => {
    const { sections } = runPipeline('Standalone Markdown content.', config)

    assert.equal(sections.length, 1)
    assert.equal(sections[0].heading, '# Document')
    assert.equal(sections[0].displayBody, 'Standalone Markdown content.')
  })

  it('should preserve source annotations as ordinary Markdown content', () => {
    const { sections } = runPipeline('# Guide\n\n> Source: /docs/guide\n\nBody text.', config)

    assert.equal(sections.length, 1)
    assert.match(sections[0].displayBody, /> Source: \/docs\/guide/)
  })

  it('should keep headings inside fenced code as content', () => {
    const { sections } = runPipeline('# Guide\n\n```md\n## Example heading\n```', config)

    assert.equal(sections.length, 1)
    assert.match(sections[0].displayBody, /## Example heading/)
  })

  it('should keep every embedding body within the configured token budget', () => {
    const { sections } = runPipeline(
      '# Guide\n\nFirst sentence has enough words to be packed. Second sentence has enough words to split.',
      { ...config, maxTokens: 12 }
    )

    assert.ok(sections.length > 1)
    for (const section of sections) assert.ok(config.measure(section.embeddingBody) <= 12)
  })
})
