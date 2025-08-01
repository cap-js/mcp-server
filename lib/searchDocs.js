import Fuse from 'fuse.js'

export async function searchMarkdownDocs(input, query, maxResults = 5, onlyCodeBlocks = false) {
  const headingRegex = /^(#{1,6}) (.+)$/gm
  const indices = []
  let match

  while ((match = headingRegex.exec(input)) !== null) {
    indices.push({
      index: match.index,
      heading: match[2],
      level: match[1].length
    })
  }

  const chunks = []
  const parentStack = []
  for (let i = 0; i < indices.length; i++) {
    const { level, heading } = indices[i]
    while (parentStack.length > 0 && parentStack[parentStack.length - 1].level >= level) {
      parentStack.pop()
    }
    const parentIndex = parentStack.length > 0 ? parentStack[parentStack.length - 1].i : null
    parentStack.push({ level, i })

    const start = indices[i].index
    const end = i + 1 < indices.length ? indices[i + 1].index : input.length
    const chunkText = input.slice(start, end).trim()

    if (chunkText) {
      // Extract code blocks
      const codeBlocks = [...chunkText.matchAll(/```[\s\S]*?```/g)].map(m => m[0])
      // Remove heading line
      const headingLine = `#`.repeat(level) + ' ' + heading
      let body = chunkText.replace(headingLine, '').trim()
      // Remove code blocks from body
      codeBlocks.forEach(cb => {
        body = body.replace(cb, '')
      })
      body = body.trim()
      // Join code blocks as a single string
      const code = codeBlocks.join('\n\n')
      chunks.push({
        heading,
        body,
        code,
        fullText: chunkText, // store the original chunk text
        level,
        parentIndex
      })
    }
  }

  // Use Fuse.js for fuzzy search
  const fuse = new Fuse(chunks, {
    keys: [
      { name: 'heading', weight: 0.6 },
      { name: 'body', weight: 0.15 },
      { name: 'code', weight: 0.25 }
    ],
    includeScore: true,
    threshold: 0.4, // strict but fuzzy
    ignoreLocation: true,
    minMatchCharLength: 2,
    useExtendedSearch: true
    // Tokenize and match word boundaries/camelCase by default
  })

  const fuseResults = fuse.search(query, { limit: maxResults * 2 })

  function buildParentHeadingChain(chunk, allChunks) {
    const chain = []
    let current = chunk
    // Only walk up parents, do not include current heading
    while (current.parentIndex !== null && allChunks[current.parentIndex]) {
      current = allChunks[current.parentIndex]
      chain.unshift(current.heading)
    }
    return chain
  }

  // Helper to get all sub-sections (children, grandchildren, etc.) for a given chunk index
  function collectSubSections(startIdx, parentLevel) {
    const collected = []
    for (let i = startIdx + 1; i < chunks.length; i++) {
      if (chunks[i].level <= parentLevel) break
      collected.push(i)
    }
    return collected
  }

  // Only return chunks with body and code, as before, but include sub-sections
  const includedIndices = new Set()
  const prioritized = fuseResults
    .map(({ item }) => item)
    .filter(item => item.fullText && item.fullText.length > 0)
    .slice(0, maxResults)
    .map(item => {
      const idx = chunks.indexOf(item)
      if (idx === -1 || includedIndices.has(idx)) return ''
      includedIndices.add(idx)
      // Collect all sub-sections
      const subSectionIndices = collectSubSections(idx, item.level)
      subSectionIndices.forEach(i => includedIndices.add(i))
      // Concatenate fullText of parent and all sub-sections
      const allTexts = [item.fullText.trim(), ...subSectionIndices.map(i => chunks[i].fullText.trim())]
      const parentChain = buildParentHeadingChain(item, chunks).join(' > ')
      if (onlyCodeBlocks) {
        // Concatenate all code blocks
        const allCodes = [item, ...subSectionIndices.map(i => chunks[i])]
          .map(c => (c.code && c.code.trim().length > 0 ? c.code.trim() : ''))
          .filter(Boolean)
        return parentChain ? `${parentChain}\n\n${allCodes.join('\n\n')}` : allCodes.join('\n\n')
      } else {
        return parentChain ? `${parentChain}\n\n${allTexts.join('\n\n')}` : allTexts.join('\n\n')
      }
    })
    .filter(str => str && str.length > 0) // Remove empty results if onlyCodeBlocks
    .join('\n\n---\n\n')
  return prioritized
}
