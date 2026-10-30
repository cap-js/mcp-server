import { parse } from './stages/01-parseMarkdown.js'
import { sectionize } from './stages/02-buildSections.js'
import { mergeSections } from './stages/03-mergeSections.js'
import { parseBlocks } from './stages/04-parseBlocks.js'
import { transformBlock, transformSection } from './stages/05-transformBlocks.js'
import { partitionBlocks } from './stages/06-partitionBlocks.js'
import { packBlocks } from './stages/07-packBlocks.js'
import { filterChunks } from './stages/08-filterChunks.js'
import { flattenNodes } from './utils.js'

// Stage modules own their algorithms; these descriptors adapt them to scoped state.
export const pipelineStages = {
  documentStart: [
  {
    id: 'parseMarkdown',
    run(document) {
      document.nodes = parse(document.text, document.config)
      document.outputParse = document.nodes
    }
  },
  {
    id: 'buildSections',
    run(document) {
      document.flattenedParse = flattenNodes(document.nodes)
      document.sections = sectionize(document.nodes, document.config)
      document.outputSectionize = document.sections
    }
  },
  {
    id: 'mergeSections',
    run(document) {
      document.sections = mergeSections(document.sections, document.config)
      document.outputMergeSections = document.sections
    }
  }
  ],
  section: [
  {
    id: 'parseBlocks',
    run(context) {
      const { document, section } = context
      if (!section.body.trim()) {
        document.dropped.emptyBodySections.push(section)
        context.skip = true
        return
      }
      context.blocks = parseBlocks(section.body.trim(), document.flattenedParse, {
        parseExtensionBlock: context.config.adapter?.parseExtensionBlock
      })
      if (context.config.debug !== false) {
        document.outputParseBlocks.push({ section, blocks: structuredClone(context.blocks) })
      }
    }
  },
  {
    id: 'transformBlocks',
    run(context) {
      const { document, section } = context
      const headingPath = section.headingPath
      const breadcrumb = (headingPath.length > 1 ? headingPath.slice(0, -1) : headingPath).join(
        ' > '
      )
      context.breadcrumb = transformBlock(
        { text: breadcrumb, type: 'heading' },
        undefined,
        context.transformOptions
      )
      context.heading = transformBlock(
        { text: section.heading, type: 'heading' },
        undefined,
        context.transformOptions
      )
      const result = transformSection(
        section,
        context.blocks,
        context.transformOptions
      )
      document.emptyTransformed.push(...result.emptyBlocks)
      context.blocks = result.nonEmpty
      if (result.isEmptySection) {
        document.dropped.emptyBodySectionsAfterTransformed.push(section)
        context.skip = true
      }
    }
  },
  {
    id: 'partitionBlocks',
    run(context) {
      if (context.config.debug !== false) {
        context.document.outputTransformBlocks.push({
          section: context.section,
          blocks: context.blocks
        })
      }
      context.partitions = partitionBlocks(context.blocks)
    }
  }
  ],
  partition: [
  {
    id: 'packBlocks',
    run(context) {
      context.fragments = packBlocks(context.blocks, context.config)
    }
  }
  ],
  documentEnd: [
  {
    id: 'filterChunks',
    run(document) {
      const result = filterChunks(
        document.chunks,
        document.config,
        document.filterPolicy
      )
      document.chunks = result.outputFilter
      document.dropped.filterDropped = result.dropped
    }
  }
  ]
}
