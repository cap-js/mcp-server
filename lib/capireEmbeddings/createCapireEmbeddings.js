import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createEmbeddings, getActiveModel } from '../calculateEmbeddings.js'
import { runPipeline } from './chunker/pipeline.js'
import { createTokenMeasure } from './chunker/tokenizer.js'

export async function resolveConfig(chunkingConfig = {}, embeddingConfig = {}) {
  const { input, text: suppliedText, ...chunkOptions } = chunkingConfig
  const pipelineConfig = {
    maxHeadingDepth: 5,
    minTokens: 10,
    ...chunkOptions
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
    output = path.resolve('embeddings'),
    model = getActiveModel(),
    capireMetadata
  } = embeddingConfig

  const tokenMeasure = await createTokenMeasure(model)

  return {
    chunkingConfig: { text, ...pipelineConfig, ...tokenMeasure },
    embeddingConfig: { id, output, model, capireMetadata }
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
  const { id, output, model, capireMetadata } = embeddingConfig

  const sections = runPipeline(text, pipelineConfig)

  return createEmbeddings(
    id,
    sections.map(formatEmbeddingText),
    sections.map((section) => section.displayBody),
    {
      dir: output,
      model,
      metadata: sections.map(toMeta),
      ...(capireMetadata !== undefined ? { capire: capireMetadata } : {})
    }
  )
}
