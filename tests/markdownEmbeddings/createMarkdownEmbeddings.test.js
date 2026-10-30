import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

const { embedText, toMeta, parseArgs, readInput, createMarkdownEmbeddings } =
  await import('../../lib/markdownEmbeddings/createMarkdownEmbeddings.js')

async function generateMarkdown(text, chunkingConfig = {}, embeddingConfig = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-input-'))
  const input = join(root, 'guide.md')
  try {
    await writeFile(input, text)
    return await createMarkdownEmbeddings(
      { text: await readInput(input), ...chunkingConfig },
      embeddingConfig
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const originalArgv = process.argv
const originalCwd = process.cwd()
afterEach(() => {
  process.argv = originalArgv
  process.chdir(originalCwd)
  writeEmbeddings.mock.resetCalls()
})

describe('Markdown embedding generation', () => {
  it('should generate from supplied Markdown without an input file', async () => {
    const text =
      '# Guide\n\n> Source: /docs/guide\n\nGeneral documentation supplied directly in memory.'

    const result = await createMarkdownEmbeddings({ text })

    assert.equal(result.count, 1)
    const [, chunks, canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(chunks.length, 1)
    assert.match(chunks[0], /General documentation supplied directly in memory/)
    assert.equal(canonical[0], 'General documentation supplied directly in memory.')
    assert.equal(options.metadata[0].source, 'https://cap.cloud.sap/docs/guide')
  })

  it('should ignore command-line input when a chunking configuration is supplied', async () => {
    const text =
      '# Guide\n\n> Source: /docs/provided\n\nSupplied documentation takes precedence over file input.'
    process.argv = ['node', 'createMarkdownEmbeddings.js', 'missing-input.md']

    await createMarkdownEmbeddings({ text })

    const [, , canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(canonical.length, 1)
    assert.equal(canonical[0], 'Supplied documentation takes precedence over file input.')
    assert.equal(options.metadata[0].source, 'https://cap.cloud.sap/docs/provided')
  })

  it('should reject empty supplied Markdown before invoking the writer', async () => {
    await assert.rejects(createMarkdownEmbeddings({ text: '' }), /Markdown text is required/)

    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })

  it('should reject null supplied Markdown before invoking the writer', async () => {
    await assert.rejects(createMarkdownEmbeddings({ text: null }), /Markdown text is required/)

    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })

  it('should embed source-annotated Markdown headings with section metadata', async () => {
    const text =
      '# Introduction\n\n> Source: /docs/guide\n\nGeneral documentation content.\n\n## Configuration\n\n> Source: /docs/guide#configuration\n\nConfigure the documented option.'

    const result = await generateMarkdown(text, {
      chunking: { minTokens: 0 }
    })

    assert.equal(result.count, 2)
    const [id, chunks, canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(id, 'code-chunks')
    assert.equal(chunks.length, 2)
    assert.match(chunks[0], /^# Introduction\n\nGeneral documentation/)
    assert.equal(canonical[1], 'Configure the documented option.')
    assert.equal(options.model, 'fixture/default-model')
    assert.equal(options.metadata[1].headingPath, 'Introduction')
    assert.equal(options.metadata[1].source, 'https://cap.cloud.sap/docs/guide#configuration')
    assert.equal('capire' in options, false)
  })

  it('should emit no chunks for Markdown without any headings', async () => {
    const result = await generateMarkdown('Plain documentation content without a heading.')

    const [, chunks, canonical] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(result.count, 0)
    assert.equal(chunks.length, 0)
    assert.equal(canonical.length, 0)
  })

  it('should drop preamble content and retain the first source-annotated section', async () => {
    await generateMarkdown(
      'Introductory documentation content.\n\n# Configuration\n\n> Source: /docs/configuration\n\nConfiguration documentation content.'
    )

    const [, , canonical] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(canonical.length, 1)
    assert.equal(canonical[0], 'Configuration documentation content.')
  })

  it('should resolve relative links against the annotated documentation source', async () => {
    await generateMarkdown(
      '# References\n\n> Source: /docs/guides/reference\n\nRead the [related guide](../related.md) for configuration details.'
    )

    const [, , canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(canonical.length, 1)
    assert.equal(canonical[0], 'Read the related guide (/docs/related) for configuration details.')
    assert.equal(options.metadata[0].source, 'https://cap.cloud.sap/docs/guides/reference')
  })

  it('should exclude release sections while retaining guide documentation', async () => {
    await generateMarkdown(
      '# Release\n\n> Source: /docs/releases/guide\n\nRelease documentation content is useful to readers.\n\n# Guide\n\n> Source: /docs/guides/guide\n\nGuide documentation content is useful to readers.'
    )

    const [, chunks] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(chunks.length, 1)
    assert.match(chunks[0], /^# Guide\n\nGuide documentation/)
  })

  it('should map documentation source annotations to the CAP host', async () => {
    await generateMarkdown(
      '# Guide\n\n> Source: /docs/guide#selected\n\nGeneral documentation for the selected guide.'
    )

    const [, , , options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(options.metadata.length, 1)
    assert.equal(options.metadata[0].source, 'https://cap.cloud.sap/docs/guide#selected')
  })

  it('should keep headings inside fenced examples as code rather than section boundaries', async () => {
    await generateMarkdown(
      '# Examples\n\n> Source: /docs/examples\n\n```md\n# Not a section\n```\n\nThis example illustrates a Markdown heading.'
    )

    const [, chunks, canonical] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(chunks.length, 1)
    assert.match(canonical[0], /# Not a section/)
  })

  it('should forward optional caller metadata and the selected model to the existing writer', async () => {
    const capire = { commitId: 'caller-provenance' }

    await generateMarkdown(
      '# Guide\n\n> Source: /docs/guide\n\nGeneral documentation content.',
      {},
      {
        id: 'guide',
        dir: '/output',
        model: 'fixture/selected-model',
        capire
      }
    )

    const [id, , , options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(id, 'guide')
    assert.equal(options.dir, '/output')
    assert.equal(options.model, 'fixture/selected-model')
    assert.deepEqual(options.capire, capire)
  })

  it('should use command-line model and output selections in the inlined orchestration', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-cli-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const input = join(root, 'guide.md')
    await writeFile(input, '# Guide\n\n> Source: /docs/guide\n\nGeneral documentation content.')
    process.argv = [
      'node',
      'createMarkdownEmbeddings.js',
      input,
      '--model',
      'fixture/selected-model',
      '--output',
      '/output/code-chunks.json'
    ]

    await createMarkdownEmbeddings()

    const [, , , options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(options.model, 'fixture/selected-model')
    assert.equal(options.dir, '/output')
  })

  it('should reject empty Markdown before invoking the writer', async () => {
    await assert.rejects(generateMarkdown('  '), /Markdown text is required/)

    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })
})

describe('migrated script helpers', () => {
  it('should retain the input, model, output and chunking argument mapping', () => {
    const result = parseArgs([
      'guide.md',
      '--model',
      'fixture/model',
      '--output',
      'chunks.json',
      '--min-chunk-size',
      '32'
    ])

    assert.equal(result.input, 'guide.md')
    assert.equal(result.model, 'fixture/model')
    assert.equal(result.overrides.output, 'chunks.json')
    assert.equal(result.overrides.minTokens, 32)
  })

  it('should retain embedding-text and source-metadata mapping', () => {
    const chunk = {
      heading: 'Heading',
      embeddingBody: 'Body',
      breadcrumb: 'Parent',
      source: 'guide.md',
      label: 'node'
    }

    assert.equal(embedText(chunk), 'Heading\n\nBody')
    assert.equal(toMeta(chunk).headingPath, 'Parent')
    assert.equal(toMeta(chunk).source, 'guide.md')
    assert.equal(toMeta(chunk).label, 'node')
  })

  it('should require a local input instead of fetching CAP documentation implicitly', async () => {
    await assert.rejects(readInput(), /Markdown input file is required/)
  })

  it('should reject missing input before invoking the writer', async () => {
    process.argv = ['node', 'createMarkdownEmbeddings.js']

    await assert.rejects(createMarkdownEmbeddings(), /Markdown input file is required/)

    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })

  it('should generate from caller-relative paths without reading markers or rotating a manifest', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await writeFile(
      join(root, 'guide.md'),
      '# Guide\n\n> Source: /docs/guide\n\nGeneral Markdown documentation content.'
    )
    await writeFile(join(root, 'manifest.json'), 'caller-owned manifest')
    process.chdir(root)
    process.argv = [
      'node',
      'createMarkdownEmbeddings.js',
      'guide.md',
      '--output',
      'code-chunks.json'
    ]

    await createMarkdownEmbeddings()

    const [, , , options] = writeEmbeddings.mock.calls[0].arguments
    const resolvedRoot = await realpath(root)
    assert.equal(options.dir, resolvedRoot)
    assert.equal(options.metadata.length, 1)
    assert.equal(options.metadata[0].source, 'https://cap.cloud.sap/docs/guide')
    assert.equal('capire' in options, false)
    assert.equal(await readFile(join(root, 'manifest.json'), 'utf8'), 'caller-owned manifest')
  })
})
