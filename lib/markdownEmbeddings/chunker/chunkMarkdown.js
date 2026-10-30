import { compileStages } from './stageHarness.js'
import { pipelineStages } from './pipelineStages.js'
import { validate } from './stages/09-validateChunks.js'

export function chunkMarkdown(text, config) {
  const adapter = config.adapter ?? {}
  const execute = compileStages(pipelineStages, adapter)
  const pipelineConfig = { ...config, ...adapter.parseOptions }
  const document = {
    text,
    config: pipelineConfig,
    metadata: structuredClone(config.metadata ?? {}),
    chunks: [],
    emptyTransformed: [],
    dropped: { emptyBodySections: [], emptyBodySectionsAfterTransformed: [] },
    outputParseBlocks: [],
    outputTransformBlocks: [],
    outputPackBlocks: []
  }

  execute('documentStart', document)
  for (const section of document.sections) {
    const context = {
      document,
      config: pipelineConfig,
      section,
      metadata: structuredClone({ ...document.metadata, ...section.metadata })
    }
    execute('section', context)
    if (context.skip) continue
    const bodyParts = []
    for (const partition of context.partitions) {
      const partitionContext = {
        document,
        sectionContext: context,
        config: pipelineConfig,
        blocks: partition.blocks,
        metadata: structuredClone({ ...context.metadata, ...partition.metadata }),
        label: partition.label,
        fragments: []
      }
      execute('partition', partitionContext)
      if (partitionContext.skip) continue
      for (const fragment of partitionContext.fragments) {
        const chunk = {
          breadcrumb: context.breadcrumb,
          heading: context.heading,
          source: context.source ?? section.source,
          displayBody: fragment.displayBody,
          embeddingBody: fragment.embeddingBody,
          depth: section.headingPath.length
        }
        if (partitionContext.label) chunk.label = partitionContext.label
        const metadata = { ...partitionContext.metadata, ...fragment.metadata }
        if (Object.keys(metadata).length) chunk.metadata = structuredClone(metadata)
        document.chunks.push(chunk)
        bodyParts.push(fragment)
      }
    }
    if (pipelineConfig.debug !== false) {
      document.outputPackBlocks.push({
        section,
        bodyParts: bodyParts.map((part) => part.embeddingBody),
        storedBodies: bodyParts.map((part) => part.displayBody)
      })
    }
  }
  execute('documentEnd', document)
  // Validation is outside extension registration, so wrappers cannot bypass it.
  try {
    document.chunks = validate(document.chunks, pipelineConfig)
  } catch (cause) {
    throw new Error(`[chunkMarkdown:validateChunks]: ${cause.message}`, { cause })
  }

  const { dropped, emptyTransformed } = document
  if (dropped.emptyBodySections.length)
    process.stderr.write(
      `[pipeline] dropped ${dropped.emptyBodySections.length} empty body sections after merged\n`
    )
  if (emptyTransformed.length)
    process.stderr.write(
      `[pipeline] dropped ${emptyTransformed.length} empty blocks after transformed\n`
    )
  if (dropped.emptyBodySectionsAfterTransformed.length)
    process.stderr.write(
      `[pipeline] dropped ${dropped.emptyBodySectionsAfterTransformed.length} empty sections after transformed\n`
    )

  return {
    sections: document.chunks,
    dropped,
    outputParse: document.outputParse,
    outputSectionize: document.outputSectionize,
    outputMergeSections: document.outputMergeSections,
    outputParseBlocks: document.outputParseBlocks,
    outputTransformBlocks: document.outputTransformBlocks,
    outputPackBlocks: document.outputPackBlocks,
    outputFilter: document.chunks
  }
}

export const runPipeline = chunkMarkdown
