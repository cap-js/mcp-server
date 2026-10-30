import {
  HTML_ANY_DIV_OPEN,
  HTML_DIV_CLOSE,
  JAVA_NODE_DIV_OPEN
} from '../utils.js'

export function parseCapireExtension(lines, index, parseNestedBlocks) {
  const match = JAVA_NODE_DIV_OPEN.exec(lines[index])
  if (!match) return undefined

  const divLines = [lines[index]]
  let depth = 1
  let nextIndex = index + 1
  while (nextIndex < lines.length && depth > 0) {
    const line = lines[nextIndex]
    divLines.push(line)
    if (HTML_ANY_DIV_OPEN.test(line)) depth++
    if (HTML_DIV_CLOSE.test(line)) depth--
    nextIndex++
  }

  const closer = divLines.at(-1)
  if (!HTML_DIV_CLOSE.test(closer.trim()))
    throw new Error(`[parseCapireBlocks] no closer for ${divLines[0]}`)

  const runtime = match[2].toLowerCase() === 'java' ? 'java' : 'node'
  const parts = parseNestedBlocks(divLines.slice(1, -1))
  if (parts.length === 0) throw new Error(`[parseCapireBlocks] no parts for ${divLines[0]}`)

  return {
    block: {
      opener: divLines[0],
      closer,
      type: runtime === 'java' ? 'java-div' : 'node-div',
      supressCut: false,
      parts,
      runtime
    },
    nextIndex
  }
}
