import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const writeEmbeddings = mock.fn(async (_id, chunks, canonical, options) => {
  if (!chunks.length) throw new Error('No chunks to save')
  if (options.metadata !== undefined && options.metadata.length !== chunks.length)
    throw new Error('metadata length must match chunks length')
  if (canonical.length !== chunks.length)
    throw new Error('canonicalChunks length must match chunks length')
  return { count: chunks.length, model: options.model, outDir: options.dir }
})
const tokenMeasure = mock.fn(async () => ({ measure: (text) => text.length, maxTokens: 1024 }))
mock.module('../../lib/calculateEmbeddings.js', {
  namedExports: {
    createEmbeddings: writeEmbeddings,
    getActiveModel: () => 'fixture/default-model'
  }
})
mock.module('../../lib/capireEmbeddings/chunker/tokenizer.js', {
  namedExports: {
    createTokenMeasure: tokenMeasure
  }
})

const {
  formatEmbeddingText,
  toMeta,
  parseArgs,
  resolveConfig,
  runCli,
  generate: generateResolved
} = await import('../../lib/capireEmbeddings/createCapireEmbeddings.js')
const { createCapireEmbeddings: generate } = await import('@cap-js/mcp-server')

async function generateWithOverrides(chunkingConfig, embeddingConfig, overrides) {
  const config = await resolveConfig(chunkingConfig, embeddingConfig, overrides)
  return generateResolved(config.chunkingConfig, config.embeddingConfig)
}

async function generateMarkdown(text, chunkingConfig = {}, embeddingConfig = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-input-'))
  const input = join(root, 'guide.md')
  try {
    await writeFile(input, text)
    return await generate(
      { text: await readFile(input, 'utf8'), ...chunkingConfig },
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
  tokenMeasure.mock.resetCalls()
})

describe('Markdown embedding generation', () => {
  it('should apply implementation defaults when the public API receives only Markdown', async () => {
    const text = '# Defaults\n\n> Source: /docs/defaults\n\nDocumentation using default settings.'

    const result = await generate({ text })

    assert.equal(result.count, 1)
    const [id, , canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(id, 'code-chunks')
    assert.equal(canonical[0], 'Documentation using default settings.')
    assert.equal(options.dir, join(originalCwd, 'embeddings'))
    assert.equal(options.model, 'fixture/default-model')
  })

  it('should use supplied settings through the two-parameter public API', async () => {
    const text = '# Overrides\n\n> Source: /docs/overrides\n\nUseful.'

    const result = await generate({ text, minTokens: 0 }, { model: 'fixture/override' })

    assert.equal(result.count, 1)
    const [id, , canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(id, 'code-chunks')
    assert.equal(canonical[0], 'Useful.')
    assert.equal(options.dir, join(originalCwd, 'embeddings'))
    assert.equal(options.model, 'fixture/override')
    assert.equal(tokenMeasure.mock.calls[0].arguments[0], 'fixture/override')
  })

  it('should apply top-level settings over nested configuration', async () => {
    const text = '# Guide\n\n> Source: /docs/guide\n\nUseful.'
    const config = Object.freeze({
      text,
      chunking: Object.freeze({ minTokens: -1, maxHeadingDepth: 'invalid' }),
      minTokens: 0,
      maxHeadingDepth: 1
    })

    const result = await generate(config)

    assert.equal(result.count, 1)
    assert.equal(tokenMeasure.mock.callCount(), 1)
  })

  it('should override both supplied configurations while preserving caller metadata', async () => {
    const text = '# Short\n\n> Source: /docs/short\n\nUseful.'
    const chunkingConfig = Object.freeze({
      text,
      chunking: Object.freeze({ minTokens: 200 }),
      minTokens: 100
    })
    const embeddingConfig = Object.freeze({
      id: 'custom',
      dir: '/caller',
      model: 'fixture/caller',
      provenance: { commitId: 'caller' }
    })
    const overrides = parseArgs([
      '--min-tokens',
      '0',
      '--model',
      'fixture/override',
      '--output',
      '/overridden/chunks.json'
    ])

    await generateWithOverrides(chunkingConfig, embeddingConfig, overrides)

    assert.equal(writeEmbeddings.mock.callCount(), 1)
    const [id, chunks, canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(chunks.length, 1)
    assert.equal(canonical[0], 'Useful.')
    assert.equal(id, 'custom')
    assert.equal(options.dir, '/overridden')
    assert.equal(options.model, 'fixture/override')
    assert.equal(options.capire, embeddingConfig.provenance)
    assert.equal(tokenMeasure.mock.callCount(), 1)
    assert.equal(tokenMeasure.mock.calls[0].arguments[0], options.model)
  })

  it('should retain top-level settings when no override is given', async () => {
    const text = '# Retained\n\n> Source: /docs/retained\n\nRetained content.'

    const resolved = await resolveConfig(
      { text, minTokens: 0, maxHeadingDepth: 2, maxTokens: 9999 },
      { id: 'retained', dir: '/retained', model: 'fixture/retained' },
      parseArgs([])
    )

    assert.equal(resolved.chunkingConfig.text, text)
    assert.equal(resolved.embeddingConfig.id, 'retained')
    assert.equal(resolved.embeddingConfig.dir, '/retained')
    assert.equal(resolved.embeddingConfig.model, 'fixture/retained')
    assert.equal(resolved.chunkingConfig.minTokens, 0)
    assert.equal(resolved.chunkingConfig.maxHeadingDepth, 2)
    assert.equal(resolved.chunkingConfig.maxTokens, 1024)
    assert.equal(resolved.chunkingConfig.measure('measured'), 8)
  })

  it('should fold deeper headings using an override even when chunking settings are supplied', async () => {
    const text =
      '# Parent\n\n> Source: /docs/parent\n\nParent content.\n\n## Child\n\n> Source: /docs/parent#child\n\nChild content.'
    const overrides = parseArgs(['--max-heading-depth', '1'])

    await generateWithOverrides(
      { text, maxHeadingDepth: 4, chunking: { maxHeadingDepth: 3 } },
      {},
      overrides
    )

    const [, chunks, canonical] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(chunks.length, 1)
    assert.match(canonical[0], /Parent content\./)
    assert.match(canonical[0], /## Child\n\nChild content\./)
  })

  it('should use an explicit input override instead of supplied Markdown', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-override-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const input = join(root, 'override.md')
    await writeFile(
      input,
      '# Override\n\n> Source: /docs/override\n\nContent from the override file.'
    )

    await generateWithOverrides(
      { text: '# Supplied\n\n> Source: /docs/supplied\n\nSupplied content.' },
      { id: 'retained' },
      parseArgs(['--input', input])
    )

    const [id, chunks, canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(chunks.length, 1)
    assert.equal(id, 'retained')
    assert.equal(canonical[0], 'Content from the override file.')
    assert.equal(options.metadata[0].source, 'https://cap.cloud.sap/docs/override')
  })

  it('should generate from supplied Markdown without an input file', async () => {
    const text =
      '# Guide\n\n> Source: /docs/guide\n\nGeneral documentation supplied directly in memory.'

    const result = await generate({ text })

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
    process.argv = ['node', 'host.js', '--input', 'missing-input.md', '--unrelated-host-option']

    await generate({ text })

    const [, , canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(canonical.length, 1)
    assert.equal(canonical[0], 'Supplied documentation takes precedence over file input.')
    assert.equal(options.metadata[0].source, 'https://cap.cloud.sap/docs/provided')
  })

  it('should reject empty supplied Markdown before invoking the writer', async () => {
    await assert.rejects(generate({ text: '' }), /Markdown text is required/)

    assert.equal(writeEmbeddings.mock.callCount(), 0)
    assert.equal(tokenMeasure.mock.callCount(), 0)
  })

  it('should reject null supplied Markdown before invoking the writer', async () => {
    await assert.rejects(generate({ text: null }), /Markdown text is required/)

    assert.equal(writeEmbeddings.mock.callCount(), 0)
    assert.equal(tokenMeasure.mock.callCount(), 0)
  })

  for (const text of [123, {}, []]) {
    it(`should reject non-string Markdown (${JSON.stringify(text)}) before initializing the tokenizer`, async () => {
      await assert.rejects(generate({ text }), /Markdown text is required/)

      assert.equal(tokenMeasure.mock.callCount(), 0)
      assert.equal(writeEmbeddings.mock.callCount(), 0)
    })
  }

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

  it('should send complete rendered inputs within the model budget for different headings', async () => {
    tokenMeasure.mock.mockImplementationOnce(async () => ({
      measure: (text) => text.length,
      maxTokens: 30
    }))
    const fixtures = [
      { heading: '# Root', body: 'r'.repeat(25) },
      { heading: '## Child', body: 'c'.repeat(25) },
      { heading: '## Longer Child', body: 'l'.repeat(25) }
    ]
    const text = fixtures
      .map(({ heading, body }, index) => `${heading}\n\n> Source: /docs/root#${index}\n\n${body}`)
      .join('\n\n')

    const result = await generate({ text, minTokens: 0 })

    assert.equal(result.count, 6)
    assert.equal(writeEmbeddings.mock.callCount(), 1)
    const [, inputs, canonical, options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(inputs.length, 6)
    assert.equal(canonical.length, 6)
    assert.equal(options.metadata.length, 6)
    for (const [index, { heading, body }] of fixtures.entries()) {
      const rendered = inputs.slice(index * 2, index * 2 + 2)
      for (const input of rendered) {
        assert.ok(input.startsWith(`${heading}\n\n`))
        assert.ok(input.length <= 30, `oversized inference input: ${input.length} characters`)
      }
      assert.equal(rendered.map((input) => input.slice(heading.length + 2)).join(''), body)
      assert.deepEqual(canonical.slice(index * 2, index * 2 + 2), [body, body])
      assert.ok(
        options.metadata
          .slice(index * 2, index * 2 + 2)
          .every((meta) => meta.source === `https://cap.cloud.sap/docs/root#${index}`)
      )
    }
  })

  it('should reject impossible heading overhead in validation before sending input to the writer', async (t) => {
    const stderr = t.mock.method(process.stderr, 'write', () => true)
    tokenMeasure.mock.mockImplementationOnce(async () => ({
      measure: (text) => text.length,
      maxTokens: 10
    }))
    const text = '## Child\n\n> Source: /docs/root#child\n\nx'

    await assert.rejects(
      generate({ text, minTokens: 0 }),
      /\[validate\] 1 chunk\(s\) failed validation/
    )

    assert.equal(stderr.mock.callCount(), 1)
    assert.match(
      stderr.mock.calls[0].arguments[0],
      /oversized embedding text \(11 > 10 tokens\): ## Child/
    )
    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })

  it('should reject generation when Markdown has no headings', async () => {
    await assert.rejects(
      generateMarkdown('Plain documentation content without a heading.'),
      /No chunks to save/
    )

    const [, chunks, canonical] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(writeEmbeddings.mock.callCount(), 1)
    assert.equal(chunks.length, 0)
    assert.equal(canonical.length, 0)
  })

  it('should reject generation when filtering removes all chunks', async () => {
    await assert.rejects(
      generate({ text: '# Guide\n\n> Source: /docs/guide\n\nTiny.' }),
      /No chunks to save/
    )

    assert.equal(writeEmbeddings.mock.callCount(), 1)
    assert.deepEqual(writeEmbeddings.mock.calls[0].arguments[1], [])
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

  it('should forward optional provenance and the selected model using the existing bundle format', async () => {
    const provenance = { commitId: 'caller-provenance', version: '1.0.0', source: 'custom-docs' }

    await generateMarkdown(
      '# Guide\n\n> Source: /docs/guide\n\nGeneral documentation content.',
      {},
      {
        id: 'guide',
        dir: '/output',
        model: 'fixture/selected-model',
        provenance
      }
    )

    const [id, , , options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(id, 'guide')
    assert.equal(options.dir, '/output')
    assert.equal(options.model, 'fixture/selected-model')
    assert.deepEqual(options.capire, provenance)
    assert.equal('provenance' in options, false)
  })

  it('should apply parsed model and output overrides during generation', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-cli-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const input = join(root, 'guide.md')
    await writeFile(input, '# Guide\n\n> Source: /docs/guide\n\nGeneral documentation content.')
    const overrides = parseArgs([
      '--input',
      input,
      '--model',
      'fixture/selected-model',
      '--output',
      '/output/code-chunks.json'
    ])

    await generateWithOverrides({}, {}, overrides)

    const [, , , options] = writeEmbeddings.mock.calls[0].arguments
    assert.equal(options.model, 'fixture/selected-model')
    assert.equal(options.dir, '/output')
    assert.equal(tokenMeasure.mock.callCount(), 1)
    assert.equal(tokenMeasure.mock.calls[0].arguments[0], 'fixture/selected-model')
  })

  it('should reject empty Markdown before invoking the writer', async () => {
    await assert.rejects(generateMarkdown('  '), /Markdown text is required/)

    assert.equal(writeEmbeddings.mock.callCount(), 0)
    assert.equal(tokenMeasure.mock.callCount(), 0)
  })
})

describe('migrated script helpers', () => {
  it('should omit all overrides when no arguments are supplied', () => {
    assert.deepEqual(parseArgs([]), {})
  })

  it('should prefer min-tokens over its alias and preserve zero', () => {
    const overrides = parseArgs(['--min-tokens', '0', '--min-chunk-size', '32'])

    assert.equal(overrides.minTokens, 0)
  })

  it('should accept named input after other options', () => {
    const overrides = parseArgs([
      '--model',
      'fixture/model',
      '--input',
      'input.md',
      '--max-heading-depth',
      '2'
    ])

    assert.equal(overrides.input, 'input.md')
    assert.equal(overrides.model, 'fixture/model')
    assert.equal(overrides.maxHeadingDepth, 2)
  })

  it('should reject positional input', () => {
    assert.throws(() => parseArgs(['input.md']), /Unexpected argument.*input\.md/)
  })

  for (const [option, value] of [
    ['min-tokens', 'invalid'],
    ['min-tokens', 'Infinity'],
    ['min-tokens', '-1'],
    ['min-tokens', '1.5'],
    ['min-tokens', ''],
    ['min-chunk-size', '-1'],
    ['max-heading-depth', '0'],
    ['max-heading-depth', '1.5']
  ]) {
    it(`should reject --${option}=${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parseArgs([`--${option}=${value}`]),
        new RegExp(`--${option} must be an integer`)
      )
    })
  }

  it('should retain the input, model, output and chunking argument mapping', () => {
    const result = parseArgs([
      '--input',
      'guide.md',
      '--model',
      'fixture/model',
      '--output',
      'chunks.json',
      '--min-chunk-size',
      '32'
    ])

    assert.deepEqual(result, {
      input: 'guide.md',
      model: 'fixture/model',
      output: 'chunks.json',
      minTokens: 32
    })
  })

  it('should retain embedding-text and source-metadata mapping', () => {
    const chunk = {
      heading: 'Heading',
      embeddingBody: 'Body',
      breadcrumb: 'Parent',
      source: 'guide.md',
      label: 'node'
    }

    assert.equal(formatEmbeddingText(chunk), 'Heading\n\nBody')
    assert.equal(toMeta(chunk).headingPath, 'Parent')
    assert.equal(toMeta(chunk).source, 'guide.md')
    assert.equal(toMeta(chunk).label, 'node')
  })

  it('should fetch CAP documentation when no text or input is supplied', async (t) => {
    const text = '# Guide\n\n> Source: /docs/guide\n\nDocumentation content.'
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(text))

    const resolved = await resolveConfig()

    assert.equal(resolved.chunkingConfig.text, text)
    assert.equal(fetchMock.mock.callCount(), 1)
    assert.equal(fetchMock.mock.calls[0].arguments[0], 'https://cap.cloud.sap/docs/llms-full.txt')
    assert.equal(tokenMeasure.mock.callCount(), 1)
  })

  it('should use supplied text without fetching CAP documentation', async (t) => {
    const text = '# Supplied\n\nContent.'
    const fetchMock = t.mock.method(globalThis, 'fetch', () =>
      assert.fail('Must not fetch with supplied text')
    )

    const resolved = await resolveConfig({ text })

    assert.equal(resolved.chunkingConfig.text, text)
    assert.equal(fetchMock.mock.callCount(), 0)
  })

  it('should reject empty fetched Markdown before initializing the tokenizer', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('   '))

    await assert.rejects(generate(), /Markdown text is required/)

    assert.equal(tokenMeasure.mock.callCount(), 0)
    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })

  it('should reject empty file input before initializing the tokenizer', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-empty-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const input = join(root, 'input.md')
    await writeFile(input, '')

    await assert.rejects(runCli(['--input', input]), /Markdown text is required/)

    assert.equal(tokenMeasure.mock.callCount(), 0)
    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })

  it('should propagate fetch errors before initializing the tokenizer', async (t) => {
    const error = new Error('Network failure')
    t.mock.method(globalThis, 'fetch', async () => {
      throw error
    })

    await assert.rejects(resolveConfig(), error)

    assert.equal(tokenMeasure.mock.callCount(), 0)
    assert.equal(writeEmbeddings.mock.callCount(), 0)
  })

  it('should reject an empty input override even when Markdown is supplied', async () => {
    await assert.rejects(
      resolveConfig({ text: '# Supplied\n\nContent.' }, {}, parseArgs(['--input', ''])),
      { code: 'ENOENT' }
    )

    assert.equal(tokenMeasure.mock.callCount(), 0)
  })

  it('should propagate file-read errors before initializing the tokenizer', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-missing-'))
    t.after(() => rm(root, { recursive: true, force: true }))

    await assert.rejects(resolveConfig({}, {}, { input: join(root, 'missing.md') }), {
      code: 'ENOENT'
    })

    assert.equal(tokenMeasure.mock.callCount(), 0)
  })

  it('should generate from default CAP documentation through the public API', async (t) => {
    const text = '# Guide\n\n> Source: /docs/guide\n\nDocumentation content.'
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(text))

    const result = await generate()

    assert.equal(result.count, 1)
    assert.equal(fetchMock.mock.callCount(), 1)
    assert.equal(writeEmbeddings.mock.calls[0].arguments[2][0], 'Documentation content.')
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
    const overrides = parseArgs(['--input', 'guide.md', '--output', 'code-chunks.json'])

    await generateWithOverrides({}, {}, overrides)

    const [, , , options] = writeEmbeddings.mock.calls[0].arguments
    const resolvedRoot = await realpath(root)
    assert.equal(options.dir, resolvedRoot)
    assert.equal(options.metadata.length, 1)
    assert.equal(options.metadata[0].source, 'https://cap.cloud.sap/docs/guide')
    assert.equal('capire' in options, false)
    assert.equal(await readFile(join(root, 'manifest.json'), 'utf8'), 'caller-owned manifest')
  })

  describe('CLI generation', () => {
    it('should fetch the CAP documentation by default', async (t) => {
      const fetchMock = t.mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(
            '# Getting Started\n\n> Source: /docs/get-started/\n\nCAP documentation content.'
          )
      )

      await runCli([])

      assert.equal(fetchMock.mock.callCount(), 1)
      assert.equal(fetchMock.mock.calls[0].arguments[0], 'https://cap.cloud.sap/docs/llms-full.txt')
      const [id, chunks, canonical, options] = writeEmbeddings.mock.calls[0].arguments
      assert.equal(id, 'code-chunks')
      assert.equal(chunks.length, 1)
      assert.equal(canonical[0], 'CAP documentation content.')
      assert.equal(options.model, 'fixture/default-model')
      assert.equal(options.dir, join(originalCwd, 'embeddings'))
      assert.equal(options.metadata[0].source, 'https://cap.cloud.sap/docs/get-started/')
    })

    it('should use a custom model when fetching the default documentation', async (t) => {
      t.mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(
            '# Getting Started\n\n> Source: /docs/get-started/\n\nCAP documentation content.'
          )
      )

      await runCli(['--model', 'fixture/custom-model'])

      const [, chunks, , options] = writeEmbeddings.mock.calls[0].arguments
      assert.equal(chunks.length, 1)
      assert.equal(options.model, 'fixture/custom-model')
      assert.equal(options.metadata[0].source, 'https://cap.cloud.sap/docs/get-started/')
    })

    it('should reject an unsuccessful HTTP response without reading or embedding it', async (t) => {
      const response = new Response(null, { status: 503 })
      const readText = t.mock.method(response, 'text', () =>
        assert.fail('Must not read failed response')
      )
      t.mock.method(globalThis, 'fetch', async () => response)

      await assert.rejects(runCli([]), {
        message: 'Failed to fetch CAP documentation: HTTP 503'
      })
      assert.equal(readText.mock.callCount(), 0)
      assert.equal(writeEmbeddings.mock.callCount(), 0)
      assert.equal(tokenMeasure.mock.callCount(), 0)
    })

    it('should use explicit input without fetching the CAP documentation', async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-cli-input-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const input = join(root, 'input.md')
      await writeFile(input, '# Input\n\n> Source: /docs/input\n\nUseful documentation content.')
      const fetchMock = t.mock.method(globalThis, 'fetch', () =>
        assert.fail('Must not fetch with explicit input')
      )

      await runCli(['--input', input])

      assert.equal(fetchMock.mock.callCount(), 0)
      assert.equal(writeEmbeddings.mock.callCount(), 1)
    })

    it('should parse named arguments and generate with the selected output and model', async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'mcp-markdown-entry-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const input = join(root, 'input.md')
      const output = join(root, 'chunks.json')
      await writeFile(input, '# Input\n\n> Source: /docs/input\n\nUseful.')

      await runCli([
        '--model',
        'fixture/cli',
        '--input',
        input,
        '--output',
        output,
        '--min-tokens',
        '0'
      ])

      const [, chunks, canonical, options] = writeEmbeddings.mock.calls[0].arguments
      assert.equal(chunks.length, 1)
      assert.equal(canonical[0], 'Useful.')
      assert.equal(options.model, 'fixture/cli')
      assert.equal(options.dir, root)
      assert.equal(options.metadata[0].source, 'https://cap.cloud.sap/docs/input')
    })

    for (const [args, message] of [
      [['--input', ''], /ENOENT/],
      [['input.md'], /Unexpected argument.*input\.md/],
      [['--min-tokens=invalid'], /--min-tokens must be an integer/]
    ]) {
      it(`should reject ${args.join(' ')}`, async (t) => {
        const fetchMock = t.mock.method(globalThis, 'fetch', () =>
          assert.fail('Must not fetch with invalid arguments')
        )

        await assert.rejects(runCli(args), message)

        assert.equal(fetchMock.mock.callCount(), 0)
        assert.equal(writeEmbeddings.mock.callCount(), 0)
        assert.equal(tokenMeasure.mock.callCount(), 0)
      })
    }
  })
})
