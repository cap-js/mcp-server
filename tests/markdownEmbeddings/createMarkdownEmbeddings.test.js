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

async function generateMarkdown(text, options = {}, argv = []) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-input-'))
  const input = join(root, 'guide.md')
  try {
    await writeFile(input, text)
    return await createMarkdownEmbeddings([input, ...argv], options)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

afterEach(() => writeEmbeddings.mock.resetCalls())

describe('Markdown embedding generation', () => {
  it('should generate from supplied Markdown without an input file', async () => {
    const text = '# Guide\n\nGeneral documentation supplied directly in memory.'

    const result = await createMarkdownEmbeddings([], { text })

    assert.equal(result.count, 1)
    const [, chunks, canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(chunks.length, 1)
    assert.match(chunks[0], /General documentation supplied directly in memory/)
    assert.equal(canonical[0], 'General documentation supplied directly in memory.')
    assert.equal(options.metadata[0].source, 'markdown')
  })

  it('should prefer supplied Markdown over reading the input file', async () => {
    const text = '# Guide\n\nSupplied documentation takes precedence over file input.'

    await createMarkdownEmbeddings(['missing-input.md'], { text, source: 'provided.md' })

    const [, , canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(canonical.length, 1)
    assert.equal(canonical[0], 'Supplied documentation takes precedence over file input.')
    assert.equal(options.metadata[0].source, 'provided.md')
  })

  it('should reject empty supplied Markdown rather than falling back to file input', async () => {
    await assert.rejects(
      generateMarkdown('# Guide\n\nValid file documentation.', { text: '' }),
      /Markdown text is required/
    )

    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })

  it('should reject non-string supplied Markdown before invoking the writer', async () => {
    await assert.rejects(createMarkdownEmbeddings([], { text: null }), /Markdown text is required/)

    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })

  it('should embed ordinary Markdown headings without source annotations or CDS metadata', async () => {
    const text =
      '# Introduction\n\nGeneral documentation content.\n\n## Configuration\n\nConfigure the documented option.'

    const result = await generateMarkdown(text, {
      source: 'guide.md',
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
    assert.equal(options.metadata[1].source, 'guide.md')
    assert.equal('capire' in options, false)
  })

  it('should retain Markdown without any headings', async () => {
    await generateMarkdown('Plain documentation content without a heading.')

    const [, chunks, canonical] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(chunks.length, 1)
    assert.match(chunks[0], /^# Document\n\nPlain documentation/)
    assert.equal(canonical[0], 'Plain documentation content without a heading.')
  })

  it('should retain preamble content before the first heading', async () => {
    await generateMarkdown(
      'Introductory documentation content.\n\n# Configuration\n\nConfiguration documentation content.'
    )

    const [, , canonical] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(canonical.length, 2)
    assert.equal(canonical[0], 'Introductory documentation content.')
  })

  it('should preserve ordinary relative links without CAP URL rewriting', async () => {
    await generateMarkdown(
      '# References\n\nRead the [related guide](../related.md) for configuration details.',
      { source: '/work/docs/guide.md' }
    )

    const [, , canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.match(canonical[0], /\.\.\/related\.md/)
    assert.equal(options.metadata[0].source, '/work/docs/guide.md')
  })

  it('should retain release documentation instead of applying the CAP release exclusion', async () => {
    await generateMarkdown('# Release\n\nRelease documentation content is useful to readers.', {
      source: '/docs/releases/guide.md'
    })

    const [, chunks] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(chunks.length, 1)
  })

  it('should preserve explicit external source annotations without adding a CAP host', async () => {
    await generateMarkdown(
      '# Guide\n\n> Source: https://example.test/guide\n\nGeneral documentation for the selected guide.'
    )

    const [, , , options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(options.metadata[0].source, 'https://example.test/guide')
  })

  it('should keep headings inside fenced examples as code rather than section boundaries', async () => {
    await generateMarkdown(
      '# Examples\n\n```md\n# Not a section\n```\n\nThis example illustrates a Markdown heading.'
    )

    const [, chunks, canonical] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(chunks.length, 1)
    assert.match(canonical[0], /# Not a section/)
  })

  it('should forward optional caller metadata and the selected model to the existing writer', async () => {
    const capire = { commitId: 'caller-provenance' }

    await generateMarkdown('# Guide\n\nGeneral documentation content.', {
      id: 'guide',
      dir: '/output',
      model: 'fixture/selected-model',
      capire
    })

    const [id, , , options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(id, 'guide')
    assert.equal(options.dir, '/output')
    assert.equal(options.model, 'fixture/selected-model')
    assert.deepEqual(options.capire, capire)
  })

  it('should use command-line model and output selections in the inlined orchestration', async () => {
    await generateMarkdown('# Guide\n\nGeneral documentation content.', {}, [
      '--model',
      'fixture/selected-model',
      '--output',
      '/output/code-chunks.json'
    ])

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
    assert.equal(result.overrides.minTokens, '32')
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
    await assert.rejects(createMarkdownEmbeddings([]), /Markdown input file is required/)

    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })

  it('should generate from caller-relative paths without reading markers or rotating a manifest', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-'))
    const originalCwd = process.cwd()
    const originalArgv = process.argv
    t.after(async () => {
      process.chdir(originalCwd)
      process.argv = originalArgv
      await rm(root, { recursive: true, force: true })
    })
    await writeFile(join(root, 'guide.md'), '# Guide\n\nGeneral Markdown documentation content.')
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
    assert.equal(options.metadata[0].source, join(resolvedRoot, 'guide.md'))
    assert.equal('capire' in options, false)
    assert.equal(await readFile(join(root, 'manifest.json'), 'utf8'), 'caller-owned manifest')
  })
})
