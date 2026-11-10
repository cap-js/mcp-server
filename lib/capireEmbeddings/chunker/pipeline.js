import { parse } from './stages/01-parse.js'
import { sectionize } from './stages/02-sectionize.js'
import { mergeSections } from './stages/03-mergeSections.js'
import { parseSectionBlocks } from './stages/04-parse-blocks.js'
import { transformSections } from './stages/05-transform.js'
import { splitSectionsByRuntime } from './stages/06-splitByRuntime.js'
import { packSections } from './stages/07-packBlocks.js'
import { filter } from './stages/08-filter.js'
import { validate } from './stages/09-validate.js'

export const stages = {
  parse,
  sectionize,
  mergeSections,
  parseSectionBlocks,
  transformSections,
  splitSectionsByRuntime,
  packSections,
  filter,
  validate
}

export function runPipeline(text, config) {
  const outputParse = stages.parse(text, config)
  const outputSectionize = stages.sectionize(outputParse, config)
  const outputMergeSections = stages.mergeSections(outputSectionize, config)
  const outputParseBlocks = stages.parseSectionBlocks(outputMergeSections, outputParse)
  const outputTransform = stages.transformSections(outputParseBlocks)
  const outputSplit = stages.splitSectionsByRuntime(outputTransform)
  const outputPack = stages.packSections(outputSplit, config)
  const outputFilter = stages.filter(outputPack, config)
  return stages.validate(outputFilter, config)
}
