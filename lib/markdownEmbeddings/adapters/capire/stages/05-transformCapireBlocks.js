import {
  transformBlock as transformGenericBlock,
  transformSection as transformGenericSection
} from '../../../chunker/stages/05-transformBlocks.js'

const runtimeLabels = { java: 'Java:', node: 'Node.js:' }

export const runtimeTransformOptions = {
  transformRuntimeBlock: (block, text) => {
    const label = runtimeLabels[block.runtime]
    return label ? `${label}\n${text}` : text
  }
}

export function transformBlock(block, source) {
  return transformGenericBlock(block, source, runtimeTransformOptions)
}

export function transformSection(section, blocks) {
  return transformGenericSection(section, blocks, runtimeTransformOptions)
}
