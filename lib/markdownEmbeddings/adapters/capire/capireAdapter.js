import { COLS_DIV_OPEN, HTML_ANY_DIV_OPEN, HTML_DIV_CLOSE, JAVA_NODE_DIV_OPEN } from './utils.js'
import { applyPatches } from './00-patchDocument.js'
import { parseCapireExtension } from './stages/04-parseCapireBlocks.js'
import { runtimeTransformOptions } from './stages/05-transformCapireBlocks.js'
import { splitByRuntime } from './stages/06-partitionByRuntime.js'
import { capireFilterPolicy } from './stages/08-filterCapireChunks.js'

const SOURCE_LINE = /^>?\s*Source:\s/

function getHeadingMetadata(lines, index) {
  const window = lines.slice(index + 1, index + 4)
  const offset = window.findIndex((line) => SOURCE_LINE.test(line))
  if (offset === -1) return undefined
  return {
    source: window[offset].replace(/^>?\s*Source:\s*/, ''),
    sourceIndex: index + 1 + offset
  }
}

function shouldIgnoreHeading(lines, lastHeadingIndex, index) {
  let closesSeen = 0
  for (let lineIndex = index - 1; lineIndex >= lastHeadingIndex; lineIndex--) {
    const line = lines[lineIndex]
    if (HTML_DIV_CLOSE.test(line)) {
      closesSeen++
      continue
    }
    if (HTML_ANY_DIV_OPEN.test(line)) {
      if (closesSeen > 0) {
        closesSeen--
        continue
      }
      if (JAVA_NODE_DIV_OPEN.test(line) || COLS_DIV_OPEN.test(line)) return true
    }
  }
  return false
}

export const capireChunkerAdapter = {
  insert: [
    {
      id: 'patchCapireDocument',
      before: 'parseMarkdown',
      run(document) {
        document.text = applyPatches(document.text)
      }
    }
  ],
  parseOptions: {
    keepPreamble: false,
    getHeadingMetadata,
    isIgnoredBodyLine: (line) => SOURCE_LINE.test(line),
    shouldIgnoreHeading
  },
  parseExtensionBlock: parseCapireExtension,
  wrap: {
    transformBlocks: (next) => (context) => {
      context.transformOptions = runtimeTransformOptions
      next(context)
      context.source = `https://cap.cloud.sap${context.section.source}`
    },
    partitionBlocks: (next) => (context) => {
      next(context)
      context.partitions = splitByRuntime(context.blocks, context.section.heading)
    },
    filterChunks: (next) => (document) => {
      document.filterPolicy = capireFilterPolicy
      next(document)
      const dropped = document.dropped.filterDropped
      dropped.releases = dropped.excluded
      dropped.toSmallBody = dropped.tooSmallBody
      delete dropped.excluded
      delete dropped.tooSmallBody
    }
  }
}
