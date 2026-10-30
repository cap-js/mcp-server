import { FENCE_OPENER, FENCE_CLOSER } from '../utils.js'

const LIST_TYPES = new Set(['list-item', 'bullet-item'])
const RUNTIME_LABELS = { java: 'Java:', node: 'Node.js:' }

function isCutSuppressed(blocks, i) {
  const prev = blocks[i - 1]
  const next = blocks[i]

  // Each top-level list item is already a complete semantic unit.
  if (next?.supressCut) return true
  if (next?.isAnaphoric) return true
  // The regex also catches heading-like paragraphs (a `#` line parsed as text
  // inside a wrapped div), which the `type` flag alone does not mark.
  if (prev?.isLeadIn || prev?.type === 'heading' || /^#{1,6}\s/.test(prev?.text ?? '')) return true
  return false
}

function joinBlocks(blocks) {
  return blocks
    .map((block) => block.text)
    .join('\n\n')
    .trim()
}

function leadInFor(blocks, i) {
  if (LIST_TYPES.has(blocks[i]?.type)) return ''
  return blocks[i - 1]?.isLeadIn ? blocks[i - 1].text : ''
}

function splitSentences(text) {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
    return [...segmenter.segment(text)].map(({ segment }) => segment.trim()).filter(Boolean)
  }
  return (
    text
      .match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)
      ?.map((part) => part.trim())
      .filter(Boolean) ?? [text]
  )
}

function packItems(items, maxTokens, measure, { prefix = '', header = '', separator = '\n' } = {}) {
  const chunks = []
  let current = []
  const render = (values) =>
    [prefix, header, values.join(separator)].filter(Boolean).join('\n\n').trim()

  for (const item of items) {
    const candidate = render([...current, item])
    if (current.length === 0 || measure(candidate) <= maxTokens) {
      current.push(item)
    } else {
      chunks.push(render(current))
      current = [item]
    }
  }
  if (current.length) chunks.push(render(current))
  return chunks
}

function splitTable(block, maxTokens, measure, prefix) {
  const lines = block.text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 2) return [block.text]
  const headerCount = block.type === 'md-table' ? 2 : 1
  const header = lines.slice(0, headerCount).join('\n')
  const rows = lines.slice(headerCount)
  if (!rows.length) return [block.text]
  const chunks = packItems(rows, maxTokens, measure, { prefix, header, separator: '\n' })
  return chunks.map((text, index) => {
    const withoutPrefix =
      prefix && text.startsWith(`${prefix}\n\n`) ? text.slice(prefix.length).trimStart() : text
    const displayBody = index === 0 ? withoutPrefix : withoutPrefix.slice(header.length).trimStart()
    return { text: withoutPrefix === text ? text : `${prefix}\n\n${withoutPrefix}`, displayBody }
  })
}

function splitFence(block, maxTokens, measure) {
  const lines = block.text.split('\n')
  const closer = lines[lines.length - 1]
  // Only split a well-formed fence. Otherwise keep the block whole.
  if (lines.length < 3 || !FENCE_CLOSER.test(closer)) return [block.text]
  const opener = lines[0]
  const body = lines.slice(1, -1)
  // A fence whose body holds its own fence delimiters (for example a
  // ````md block that shows ```js examples) cannot be cut without breaking
  // the nesting. Keep such a fence whole.
  if (body.some((line) => FENCE_OPENER.test(line))) return [block.text]
  const render = (slice) => [opener, ...slice, closer].join('\n')
  const fragments = []
  let current = []
  for (const line of body) {
    if (current.length === 0 || measure(render([...current, line])) <= maxTokens) {
      current.push(line)
    } else {
      fragments.push(render(current))
      current = [line]
    }
  }
  if (current.length) fragments.push(render(current))
  if (fragments.length < 2) return [block.text]
  return fragments.map((text) => ({ text, displayBody: text }))
}

function splitParagraph(block, maxTokens, measure) {
  const sentences = splitSentences(block.text)
  if (sentences.length < 2) return [block.text]
  return packItems(sentences, maxTokens, measure, { separator: ' ' }).map((text) => ({
    text,
    displayBody: text
  }))
}

function withoutLeadIns(blocks) {
  return blocks.map((block) => ({
    ...block,
    isLeadIn: false,
    parts: block.parts ? withoutLeadIns(block.parts) : block.parts
  }))
}

function renderAdmonition(opener, inner) {
  return `${opener}\n${inner
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}`.trim()
}

function splitAdmonition(block, maxTokens, measure) {
  if (!block.parts?.length) return [block.text]
  const opener = block.text.split('\n')[0]
  const wrappedMeasure = (inner) => measure(renderAdmonition(opener, inner))
  const inners = packBlocks(block.parts, { maxTokens, measure: wrappedMeasure })
  if (inners.length < 2) return [block.text]
  const texts = inners.map((inner, index) => ({
    text: renderAdmonition(opener, inner.embeddingBody),
    displayBody: index === 0 ? renderAdmonition(opener, inner.displayBody) : inner.displayBody
  }))
  return texts.every((fragment) => measure(fragment.text) <= maxTokens) ? texts : [block.text]
}

function splitWrappedBlock(block, maxTokens, measure) {
  if (!block.parts?.length) return [block.text]
  if (LIST_TYPES.has(block.type)) {
    const opener = block.opener ?? ''
    const wrappedMeasure = (inner) => measure(`${opener}\n${inner}`.trim())
    const inner = packBlocks(withoutLeadIns(block.parts), { maxTokens, measure: wrappedMeasure })
    return inner.map((fragment, index) => ({
      text: index === 0 ? `${opener}\n${fragment.embeddingBody}`.trim() : fragment.embeddingBody,
      displayBody: index === 0 ? `${opener}\n${fragment.displayBody}`.trim() : fragment.displayBody
    }))
  }
  const label = RUNTIME_LABELS[block.runtime] ?? ''
  const opener = label || block.opener || ''
  const closer = label ? '' : block.closer?.trim()
  const wrappedMeasure = (inner) =>
    measure([opener, inner, closer].filter(Boolean).join('\n').trim())
  const inner = packBlocks(block.parts, { maxTokens, measure: wrappedMeasure })
  if (inner.length < 2) return [block.text]
  return inner.map((fragment, index) => ({
    text: [opener, fragment.embeddingBody, closer].filter(Boolean).join('\n'),
    displayBody:
      index === 0
        ? [opener, fragment.displayBody, closer].filter(Boolean).join('\n')
        : fragment.displayBody
  }))
}

function fencesBalanced(text) {
  return (
    (text.match(/`{3,}/g) || []).length % 2 === 0 && (text.match(/~{3,}/g) || []).length % 2 === 0
  )
}

function fenceBalanced(texts) {
  return texts.every((fragment) => fencesBalanced(fragment.text))
}

function isStandaloneFenceLine(line) {
  return /^\s*(?:```+|~~~+)/u.test(line)
}

function forceSplitWords(text, maxTokens, measure) {
  const units = text.match(/\S+\s*/gu) ?? []
  const fragments = []
  let current = ''
  const append = (unit) => {
    if (current && measure(current + unit) > maxTokens) {
      fragments.push(current.trimEnd())
      current = ''
    }
    if (measure(unit) <= maxTokens) {
      current += unit
      return
    }
    for (const codePoint of Array.from(unit)) {
      if (current && measure(current + codePoint) > maxTokens) {
        fragments.push(current.trimEnd())
        current = ''
      }
      current += codePoint
    }
  }
  for (const unit of units) append(unit)
  if (current) fragments.push(current.trimEnd())
  return fragments.filter(Boolean)
}

// Last-resort split: strip every fence marker (standalone delimiter lines and
// inline ``` / ~~~ sequences) so the output is always fence-balanced, then
// break the remaining prose at word, then code-point, boundaries.
function forceFit(text, maxTokens, measure) {
  const stripped = text
    .split('\n')
    .filter((line) => !isStandaloneFenceLine(line))
    .join('\n')
    .replace(/`{3,}|~{3,}/g, '')
    .trim()
  return forceSplitWords(stripped || text, maxTokens, measure)
}

// Called only after splitOverflowBlock confirms that the block exceeds the budget.
function sliceBlock(block, maxTokens, measure) {
  if (block.type === 'md-table' || block.type === 'html-table')
    return splitTable(block, maxTokens, measure)
  if (block.type === 'paragraph') return splitParagraph(block, maxTokens, measure)
  if (block.type === 'admonition') return splitAdmonition(block, maxTokens, measure)
  if (block.type === 'fence') return splitFence(block, maxTokens, measure)
  if (block.parts?.length) return splitWrappedBlock(block, maxTokens, measure)
  return [block.text]
}

function splitOverflowBlock(blocks, i, maxTokens, measure) {
  const block = blocks[i]
  const whole = { fragments: [{ ...block, displayBody: block.text }], consumedNext: false }
  // The combined candidate overflowed, but this block may still fit on its own.
  // The supplied measure includes any outer wrappers and pending headings.
  if (measure(block.text) <= maxTokens) return whole

  // Context that wraps every fragment: the lead-in before, and a trailing block
  // that wants to stick (anaphoric or supressCut) after.
  const leadIn = leadInFor(blocks, i)
  const prefix = leadIn
  const next = blocks[i + 1]
  let suffix = next && isCutSuppressed(blocks, i + 1) ? next.text : ''
  let consumedNext = Boolean(suffix)
  const renderContext = (text) => [prefix, text, suffix].filter(Boolean).join('\n\n').trim()
  const measureWithContext = (text) => measure(renderContext(text))
  // sliceBlock deliberately receives the original budget: its measure is the
  // complete rendered candidate, including both sides of the context.
  let texts = sliceBlock(block, maxTokens, measureWithContext)
  const valid = (candidates) =>
    candidates.length >= 2 &&
    fenceBalanced(candidates) &&
    candidates.every((fragment) => measureWithContext(fragment.text) <= maxTokens)
  if (!valid(texts) && suffix) {
    suffix = ''
    consumedNext = false
    // renderContext reads the updated suffix for both splitting and validation.
    texts = sliceBlock(block, maxTokens, measureWithContext)
  }
  // No structural split fits: keep the block whole. flush() guarantees the
  // budget by hard-splitting any oversized body it is asked to emit.
  if (!valid(texts)) return whole

  // The display body always shows the whole original block, wrapped by the same
  // prefix and suffix. Only the embedding text differs between fragments.
  const displayBody = renderContext(block.text)
  const fragments = texts.map((fragment, index) => ({
    ...block,
    text: renderContext(fragment.text),
    displayBody,
    isLeadIn: index === texts.length - 1 && block.isLeadIn,
    isAnaphoric: index === 0 && block.isAnaphoric,
    supressCut: false,
    parts: undefined
  }))
  return { fragments, consumedNext }
}

export function packBlocks(inputBlocks, config) {
  const { maxTokens, measure } = config
  const blocks = inputBlocks.filter(
    (block) => (block.text ?? '').trim() !== '' || block.parts?.length
  )
  const complete = joinBlocks(blocks)
  if (measure(complete) <= maxTokens && fencesBalanced(complete))
    return complete ? [{ embeddingBody: complete, displayBody: complete }] : []

  const chunks = []
  let current = []
  let pendingHeadings = []
  // The single budget chokepoint: every emitted chunk passes through here. A
  // body that fits and is fence-balanced is pushed as-is; anything else is
  // stripped of fences and word-split so no chunk ever exceeds maxTokens.
  const pushGuarded = (embeddingBody, displayBody) => {
    if (measure(embeddingBody) <= maxTokens && fencesBalanced(embeddingBody)) {
      chunks.push({ embeddingBody, displayBody })
      return
    }
    for (const piece of forceFit(embeddingBody, maxTokens, measure))
      chunks.push({ embeddingBody: piece, displayBody })
  }
  const flush = (values) => {
    const group = [...pendingHeadings, ...values]
    // Hold back trailing heading blocks. They lead the next chunk.
    let end = group.length
    while (end > 0 && group[end - 1].type === 'heading') end--
    pendingHeadings = group.slice(end)
    const emit = group.slice(0, end)
    // Everything buffered was a trailing heading; it carries forward in
    // pendingHeadings, so there is nothing to emit yet.
    if (group.every((block) => block.type === 'heading')) return
    const embeddingBody = joinBlocks(emit)
    const displayBody = emit
      .map((block) => block.displayBody ?? block.text)
      .join('\n\n')
      .trim()
    pushGuarded(embeddingBody, displayBody)
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const headingPrefix = joinBlocks(pendingHeadings)
    const measureBody = (body) => measure([headingPrefix, body].filter(Boolean).join('\n\n').trim())

    const candidate = joinBlocks([...current, block])
    if (measureBody(candidate) <= maxTokens) {
      current.push(block)
      continue
    }

    // Check whether the block itself overflows before attempting a structural split.
    const { fragments, consumedNext } = splitOverflowBlock(blocks, i, maxTokens, measureBody)
    if (fragments.length > 1) {
      // The lead-in is now baked into every fragment's prefix, so drop it from
      // the buffer to avoid emitting it twice.
      if (leadInFor(blocks, i)) {
        const leadIndex = current.lastIndexOf(blocks[i - 1])
        if (leadIndex >= 0) current.splice(leadIndex, 1)
      }

      const [first, ...rest] = fragments
      if (measureBody(joinBlocks([...current, first])) <= maxTokens) {
        current.push(first)
      } else {
        flush(current)
        current = [first]
      }

      flush(current)
      current = []
      for (const fragment of rest) flush([fragment])
      if (consumedNext) i += 1
      continue
    }

    if (current.length === 0) {
      current.push(block)
      continue
    }

    if (!isCutSuppressed(blocks, i)) {
      flush(current)
      current = [block]
      continue
    }

    if (!isCutSuppressed(blocks, i - 1)) {
      const carried = [current[current.length - 1], block]
      const carriedBody = joinBlocks(carried)
      if (measureBody(carriedBody) <= maxTokens) {
        flush(current.slice(0, -1))
        current = carried
      } else {
        flush(current)
        current = [block]
      }
    } else {
      flush(current)
      current = [block]
    }
  }

  if (current.length) flush(current)

  // Trailing headings with no content after them stay with the last chunk.
  if (pendingHeadings.length) {
    const tail = joinBlocks(pendingHeadings)
    const tailBody = pendingHeadings
      .map((b) => b.text)
      .join('\n\n')
      .trim()
    const last = chunks[chunks.length - 1]
    const attached = last ? `${last.embeddingBody}\n\n${tail}`.trim() : ''
    if (last && measure(attached) <= maxTokens && fencesBalanced(attached)) {
      last.embeddingBody = attached
      last.displayBody = `${last.displayBody}\n\n${tailBody}`.trim()
    } else {
      pushGuarded(tail, tailBody)
    }
  }

  return chunks
}
