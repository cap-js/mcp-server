import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs as utilParseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createEmbeddings, getActiveModel } from '../calculateEmbeddings.js'
import { runPipeline } from './chunker/pipeline.js'
import { createTokenMeasure } from './chunker/tokenizer.js'

export function parseArgs(argv = []) {
  const { values } = utilParseArgs({
    args: argv,
    options: {
      'min-tokens': { type: 'string' },
      'min-chunk-size': { type: 'string' },
      'max-heading-depth': { type: 'string' },
      input: { type: 'string' },
      output: { type: 'string' },
      model: { type: 'string' }
    },
    allowPositionals: false
  })

  const overrides = {}
  const integer = (name, value, minimum) => {
    const number = Number(value)
    if (!value.trim() || !Number.isSafeInteger(number) || number < minimum)
      throw new Error(`--${name} must be an integer greater than or equal to ${minimum}`)
    return number
  }
  const minTokens = values['min-tokens'] ?? values['min-chunk-size']
  if (minTokens !== undefined)
    overrides.minTokens = integer(
      values['min-tokens'] !== undefined ? 'min-tokens' : 'min-chunk-size',
      minTokens,
      0
    )
  if (values['max-heading-depth'] !== undefined)
    overrides.maxHeadingDepth = integer('max-heading-depth', values['max-heading-depth'], 1)
  if (values.input !== undefined) overrides.input = values.input
  if (values.model !== undefined) overrides.model = values.model
  if (values.output !== undefined) overrides.output = values.output

  return overrides
}

export async function resolveConfig(chunkingConfig = {}, embeddingConfig = {}, overrides = {}) {
  const { input, output, model: modelOverride, ...chunkOverrides } = overrides
  const { text: suppliedText, ...chunkOptions } = chunkingConfig
  const pipelineConfig = {
    maxHeadingDepth: 5,
    minTokens: 10,
    ...chunkOptions,
    ...chunkOverrides
  }
  let text = suppliedText
  if (input !== undefined) {
    text = await readFile(input, 'utf8')
  } else if (suppliedText === undefined) {
    const response = await fetch('https://cap.cloud.sap/docs/llms-full.txt')
    if (!response.ok) throw new Error(`Failed to fetch CAP documentation: HTTP ${response.status}`)
    text = await response.text()
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('Markdown text is required')
  const {
    id = 'code-chunks',
    dir = path.resolve('embeddings'),
    model = getActiveModel(),
    provenance
  } = {
    ...embeddingConfig,
    ...(output !== undefined ? { dir: path.dirname(path.resolve(output)) } : {}),
    ...(modelOverride !== undefined ? { model: modelOverride } : {})
  }

  const tokenMeasure = await createTokenMeasure(model)

  return {
    chunkingConfig: { text, ...pipelineConfig, ...tokenMeasure },
    embeddingConfig: { id, dir, model, provenance }
  }
}

export function formatEmbeddingText(chunk) {
  return [chunk.heading, chunk.embeddingBody].filter(Boolean).join('\n\n')
}

export function toMeta(chunk) {
  const meta = { headingPath: chunk.breadcrumb, source: chunk.source }
  if (chunk.label) meta.label = chunk.label
  return meta
}

export async function generate(chunkingConfig, embeddingConfig = {}) {
  const { text, ...pipelineConfig } = chunkingConfig
  const { id, dir, model, provenance } = embeddingConfig

  const sections = runPipeline(text, pipelineConfig)

  return createEmbeddings(
    id,
    sections.map(formatEmbeddingText),
    sections.map((section) => section.displayBody),
    {
      dir,
      model,
      metadata: sections.map(toMeta),
      // Keep the existing bundle format independent of the public option name.
      ...(provenance !== undefined ? { capire: provenance } : {})
    }
  )
}

export async function runCli(argv) {
  const overrides = parseArgs(argv)
  const { chunkingConfig, embeddingConfig } = await resolveConfig({}, {}, overrides)
  return generate(chunkingConfig, embeddingConfig)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runCli(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${err.stack}\n`)
    process.exitCode = 1
  }
}
