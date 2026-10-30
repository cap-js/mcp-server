export {
  COLS_DIV_OPEN,
  CONTAINER_CLOSER,
  CONTAINER_OPENER,
  FENCE_CLOSER,
  FENCE_OPENER,
  firstMeaningfulLine,
  HTML_ANY_DIV_OPEN,
  HTML_DIV_CLOSE,
  isHtmlStub,
  lastMeaningfulLine,
  MD_HEADING
} from '../../chunker/utils.js'

export const JAVA_NODE_DIV_OPEN = /^<div\s+class="(impl\s+)?(java|node)(\s+[^"]*)?"/i

export function detectRuntime(text) {
  if (!text) return undefined
  const hasJava = /\bJava\b/.test(text)
  const hasNode = /\bNode\.js\b/.test(text)
  if (hasJava === hasNode) return undefined
  return hasJava ? 'java' : 'node'
}

export function runtimesOf(block) {
  if (block.runtime) return [block.runtime]
  const runtimes = []
  for (const part of block.parts ?? []) {
    for (const runtime of runtimesOf(part)) {
      if (!runtimes.includes(runtime)) runtimes.push(runtime)
    }
  }
  return runtimes
}

export function isPure(block, runtime) {
  const runtimes = runtimesOf(block)
  return runtimes.length === 1 && runtimes.includes(runtime)
}

export function projectForRuntime(block, runtime) {
  const other = runtime === 'java' ? 'node' : 'java'
  if (!block.parts || !runtimesOf(block).includes(other)) return block
  const parts = block.parts.filter((part) => !runtimesOf(part).has(other))
  const separator = ['list', 'list-item', 'bullet-item'].includes(block.type) ? '\n' : '\n\n'
  const text = parts.map((part) => part.text).join(separator)
  return {
    ...block,
    parts,
    text: block.opener ? `${block.opener}\n${text}${block.closer ? `\n${block.closer.trim()}` : ''}` : text
  }
}
