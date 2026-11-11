import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs as utilParseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { embeddingCliOptions, embeddingCliOverrides, embeddingCliConfig } from '../utils.js'
import { createCapireEmbeddings } from '../api.js'
import { createEmbeddings, getActiveModel } from '../calculateEmbeddings.js'
import { runPipeline } from './chunker/pipeline.js'
import { createTokenMeasure } from './chunker/tokenizer.js'

export function parseArgs(argv = []) {
  const { values } = utilParseArgs({
    args: argv,
    options: embeddingCliOptions,
    allowPositionals: false
  })

  return embeddingCliOverrides(values)
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
    capireMetadata
  } = {
    ...embeddingConfig,
    ...(output !== undefined ? { dir: path.dirname(path.resolve(output)) } : {}),
    ...(modelOverride !== undefined ? { model: modelOverride } : {})
  }

  const tokenMeasure = await createTokenMeasure(model)

  return {
    chunkingConfig: { text, ...pipelineConfig, ...tokenMeasure },
    embeddingConfig: { id, dir, model, capireMetadata }
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
  const { id, dir, model, capireMetadata } = embeddingConfig

  const sections = runPipeline(text, pipelineConfig)

  return createEmbeddings(
    id,
    sections.map(formatEmbeddingText),
    sections.map((section) => section.displayBody),
    {
      dir,
      model,
      metadata: sections.map(toMeta),
      ...(capireMetadata !== undefined ? { capire: capireMetadata } : {})
    }
  )
}

export async function runCli(argv) {
  const overrides = parseArgs(argv)
  const { chunkingConfig, embeddingConfig } = await embeddingCliConfig(overrides)
  return createCapireEmbeddings(chunkingConfig, embeddingConfig)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runCli(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${err.stack}\n`)
    process.exitCode = 1
  }
}
