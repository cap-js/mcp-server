import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'

const writeEmbeddings = mock.fn(async (_id, chunks, _canonical, options) => ({
  count: chunks.length,
  model: options.model,
  outDir: options.dir
}))
mock.module('../../lib/calculateEmbeddings.js', {
  namedExports: {
    createEmbeddings: writeEmbeddings,
    getActiveModel: () => 'fixture/default-model'
  }
})
mock.module('../../lib/markdownEmbeddings/chunker/tokenizer.js', {
  namedExports: {
    createTokenMeasure: async () => ({ measure: (text) => text.length, maxTokens: 1024 })
  }
})

const { createMarkdownEmbeddings, parseArgs, readInput } =
  await import('../../lib/markdownEmbeddings/createMarkdownEmbeddings.js')

afterEach(() => writeEmbeddings.mock.resetCalls())

describe('Markdown embedding generation', () => {
  it('should forward metadata added by an inserted stage to the embedding writer', async () => {
    const adapter = {
      insert: [
        {
          id: 'annotate',
          after: 'transformBlocks',
          run(context) {
            context.metadata.category = 'fixture'
          }
        }
      ]
    }

    await createMarkdownEmbeddings({ text: '# Root\n\nDocument content.', adapter })

    const options = writeEmbeddings.mock.calls[0].arguments[3]
    assert.equal(options.metadata.length, 1)
    assert.equal(options.metadata[0].category, 'fixture')
  })
  it('should generate embeddings from supplied Markdown and preserve caller metadata', async () => {
    const result = await createMarkdownEmbeddings(
      { text: '# Guide\n\nDocumentation content.', source: 'guide.md', minTokens: 0 },
      { id: 'guide', dir: '/output', model: 'fixture/model' }
    )

    assert.equal(result.count, 1)
    const [id, chunks, canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(id, 'guide')
    assert.equal(chunks.length, 1)
    assert.equal(canonical[0], 'Documentation content.')
    assert.equal(options.dir, '/output')
    assert.equal(options.model, 'fixture/model')
    assert.equal(options.metadata[0].source, 'guide.md')
  })

  it('should retain headingless Markdown as a document section', async () => {
    await createMarkdownEmbeddings({ text: 'Standalone documentation.', source: 'guide.md' })

    const [, chunks, canonical] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(chunks.length, 1)
    assert.match(chunks[0], /^# Document/)
    assert.equal(canonical[0], 'Standalone documentation.')
  })

  it('should preserve source annotations as document content', async () => {
    await createMarkdownEmbeddings({
      text: '# Guide\n\n> Source: /docs/guide\n\nContent.',
      source: 'guide.md'
    })

    const [, , canonical] = writeEmbeddings.mock.calls[0].arguments
    assert.match(canonical[0], /> Source: \/docs\/guide/)
  })

  it('should reject empty Markdown before invoking the writer', async () => {
    await assert.rejects(createMarkdownEmbeddings({ text: '  ' }), /Markdown text is required/)
    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })
})

describe('generator helpers', () => {
  it('should parse supported chunking arguments', () => {
    const result = parseArgs(['guide.md', '--model', 'fixture/model', '--min-tokens', '32'])

    assert.equal(result.input, 'guide.md')
    assert.equal(result.model, 'fixture/model')
    assert.equal(result.overrides.minTokens, 32)
  })

  it('should require an input path when used as a CLI helper', async () => {
    await assert.rejects(readInput(), /Markdown input file is required/)
  })
})
