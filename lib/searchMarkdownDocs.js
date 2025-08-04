import MiniSearch from 'minisearch'

export default async function searchMarkdownDocs(input, query, maxResults = 3, codeOnly = false) {
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
      chunks.push({
        id: i,
        heading,
        codeBlocks,
        content: chunkText, // store the original chunk text
        level,
        parentIndex
      })
    }
  }

  let miniSearch = new MiniSearch({
    fields: ['content'], // fields to index for full-text search
    storeFields: ['content', 'id', 'parentIndex'] // fields to return with search results
  })

  miniSearch.addAll(chunks)
  let results = miniSearch.search(query, { limit: maxResults })
  // Helper to build heading path
  function buildHeadingPath(chunks, idx) {
    const path = []
    let current = idx
    while (current !== null && current !== undefined) {
      const chunk = chunks[current]
      if (chunk) path.unshift(chunk.heading)
      current = chunk.parentIndex
    }
    return path.join(' > ')
  }

  if (codeOnly) {
    return results
      .map(r => {
        const chunk = chunks[r.id]
        const headingPath = buildHeadingPath(chunks, r.id)
        const headingLine = `#`.repeat(chunk.level) + ' ' + chunk.heading
        if (chunk.codeBlocks?.length && chunk.codeBlocks.join('\n')) {
          return `${headingPath}\n\n${headingLine}\n${chunk.codeBlocks.join('\n\n')}`
        }
        return null
      })
      .filter(Boolean)
      .slice(0, maxResults)
      .join('\n---\n')
  } else {
    return results
      .slice(0, maxResults)
      .map(r => {
        const headingPath = buildHeadingPath(chunks, r.id)
        return `${headingPath}\n\n${r.content}`
      })
      .join('\n---\n')
  }
}
