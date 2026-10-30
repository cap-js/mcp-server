import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs as utilParseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createEmbeddings, getActiveModel } from '../calculateEmbeddings.js'
import { runPipeline } from './chunker/pipeline.js'
import { createTokenMeasure } from './chunker/tokenizer.js'

export function parseArgs(argv = []) {
  const { values, positionals } = utilParseArgs({
    args: argv,
    options: {
      'min-tokens': { type: 'string' },
      'min-chunk-size': { type: 'string' },
      'max-heading-depth': { type: 'string' },
      output: { type: 'string' },
      model: { type: 'string' }
    },
    allowPositionals: true
  })

  const overrides = {}
  const minTokens = values['min-tokens'] ?? values['min-chunk-size']
  if (minTokens !== undefined) overrides.minTokens = Number(minTokens)
  if (values['max-heading-depth'] !== undefined)
    overrides.maxHeadingDepth = Number(values['max-heading-depth'])
  if (values.output !== undefined) overrides.output = values.output

  return { overrides, input: positionals[0] ?? null, model: values.model ?? null }
}

export async function readInput(input) {
  if (!input) throw new Error('A Markdown input file is required')
  return readFile(input, 'utf8')
}

export function embedText(chunk) {
  return [chunk.heading, chunk.embeddingBody].filter(Boolean).join('\n\n')
}

export function toMeta(chunk) {
  const meta = { headingPath: chunk.breadcrumb, source: chunk.source }
  if (chunk.label) meta.label = chunk.label
  return meta
}

export async function config(chunkingConfig, embeddingConfig = {}) {
  if (chunkingConfig === undefined) {
    const { overrides, input, model } = parseArgs(process.argv.slice(2))
    const { output, ...chunkOverrides } = overrides
    chunkingConfig = { text: await readInput(input), ...chunkOverrides }
    embeddingConfig = {
      dir: output ? path.dirname(path.resolve(output)) : undefined,
      model: model || undefined
    }
  }

  const { text, chunking = {}, ...chunkOverrides } = chunkingConfig
  const {
    id = 'code-chunks',
    dir = path.resolve('embeddings'),
    model = getActiveModel(),
    capire
  } = embeddingConfig

  const tokenMeasure = await createTokenMeasure(model)
  const pipelineConfig = {
    maxHeadingDepth: 5,
    minTokens: 10,
    ...chunking,
    ...chunkOverrides,
    ...tokenMeasure
  }

  return { text, id, dir, model, capire, pipelineConfig }
}

export async function createMarkdownEmbeddings(chunkingConfig, embeddingConfig = {}) {
  const { text, id, dir, model, capire, pipelineConfig } = await config(
    chunkingConfig,
    embeddingConfig
  )

  if (!text?.trim()) throw new Error('Markdown text is required')
  const { sections } = runPipeline(text, pipelineConfig)

  return createEmbeddings(
    id,
    sections.map(embedText),
    sections.map((section) => section.displayBody),
    {
      dir,
      model,
      metadata: sections.map(toMeta),
      ...(capire !== undefined ? { capire } : {})
    }
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createMarkdownEmbeddings().catch((err) => {
    process.stderr.write(`${err.stack}\n`)
    process.exitCode = 1
  })
}
