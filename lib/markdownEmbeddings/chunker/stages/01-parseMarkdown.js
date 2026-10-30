import {
  CONTAINER_OPENER,
  CONTAINER_CLOSER,
  MD_HEADING,
  FENCE_OPENER,
  FENCE_CLOSER
} from '../utils.js'

function isNotInsideFence(lines, lastHeadingIndex, index) {
  let fenceChar = null
  let fenceLen = 0
  for (let i = lastHeadingIndex; i < index; i++) {
    const line = lines[i]
    const m = FENCE_OPENER.exec(line)
    if (!m) continue
    if (fenceChar === null) {
      fenceChar = m[2][0]
      fenceLen = m[2].length
    } else if (FENCE_CLOSER.test(line) && m[2][0] === fenceChar && m[2].length >= fenceLen) {
      fenceChar = null
      fenceLen = 0
    }
  }
  return fenceChar === null
}

export function isHeadingLine(lines, index, defaultSource, getHeadingMetadata) {
  const match = MD_HEADING.exec(lines[index])
  if (!match) return null
  const metadata = getHeadingMetadata?.(lines, index)
  if (metadata === undefined && defaultSource === undefined && getHeadingMetadata) return null
  return {
    depth: match[1].length,
    title: match[2].trim(),
    source: metadata?.source ?? defaultSource,
    sourceIndex: metadata?.sourceIndex
  }
}

function findContainerEnds(lines) {
  const stack = []
  const ends = new Map()
  let fenceChar = null
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = FENCE_OPENER.exec(line)
    if (fence) {
      if (fenceChar === null) {
        fenceChar = fence[2][0]
        fenceLen = fence[2].length
      } else if (
        FENCE_CLOSER.test(line) &&
        fence[2][0] === fenceChar &&
        fence[2].length >= fenceLen
      ) {
        fenceChar = null
        fenceLen = 0
      }
      continue
    }
    if (fenceChar !== null) continue
    if (CONTAINER_OPENER.test(line)) {
      stack.push(i)
      ends.set(i, undefined) // Include unclosed openers, but not fenced examples.
    } else if (CONTAINER_CLOSER.test(line)) {
      ends.set(i, i) // Mark real closers for the backward recovery scan.
      if (stack.length > 0) ends.set(stack.pop(), i)
    }
  }
  return ends
}

function isNotInsideContainer(lines, lastHeadingIndex, index, containerEnds) {
  let crossedCloser = false
  for (let i = index - 1; i >= lastHeadingIndex; i--) {
    if (!containerEnds.has(i)) continue
    const line = lines[i]
    // After a closer, only a matched outer container can still enclose the heading.
    if (CONTAINER_OPENER.test(line) && (!crossedCloser || containerEnds.get(i) > index))
      return false
    if (CONTAINER_CLOSER.test(line)) crossedCloser = true
  }
  return true
}

export function parse(text, config = {}) {
  const lines = text.split('\n')
  const containerEnds = findContainerEnds(lines)
  const roots = []
  const stack = []
  let buffer = []
  let preamble = null

  const flushBuffer = () => {
    const raw = buffer.join('\n')
    buffer = []
    if (stack.length > 0) {
      stack[stack.length - 1].body = raw
        .split('\n')
        .filter((line, index) => !config.isIgnoredBodyLine?.(line, index))
        .join('\n')
        .trimStart()
    } else if (raw.trim() !== '') {
      if (!preamble) {
        preamble = { depth: 0, title: '', raw: '', children: [], source: '', body: '' }
      }
      preamble.body = raw
        .split('\n')
        .filter((line, index) => !config.isIgnoredBodyLine?.(line, index))
        .join('\n')
        .trimStart()
    }
  }

  let lastHeadingIndex = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const heading = isHeadingLine(lines, i, config.source, config.getHeadingMetadata)

    if (
      heading &&
      !config.shouldIgnoreHeading?.(lines, lastHeadingIndex, i) &&
      isNotInsideContainer(lines, lastHeadingIndex, i, containerEnds) &&
      isNotInsideFence(lines, lastHeadingIndex, i)
    ) {
      lastHeadingIndex = i
      flushBuffer()

      const node = {
        depth: heading.depth,
        title: heading.title,
        raw: line,
        children: [],
        source: heading.source,
        body: ''
      }

      while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) {
        stack.pop()
      }

      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node)
      } else {
        roots.push(node)
      }

      stack.push(node)
    } else {
      buffer.push(line)
    }
  }

  flushBuffer()

  if (preamble) {
    if (config.keepPreamble !== false) {
      roots.unshift({
        ...preamble,
        depth: 1,
        title: config.preambleTitle ?? 'Document',
        raw: '# Document',
        source: config.source
      })
    } else {
      process.stderr.write(`[parse] warning: preamble content found before first heading\n`)
    }
  }

  return roots
}
