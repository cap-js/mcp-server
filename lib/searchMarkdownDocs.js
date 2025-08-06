import { loadChunks, searchEmbeddings } from './embeddings.js'

export default async function searchMarkdownDocs(query, maxResults = 3, codeOnly = false) {
  const chunks = await loadChunks('capire')
  const results = (await searchEmbeddings(chunks, query)).slice(0, maxResults)

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

  // Helper to collect all descendant chunk IDs for a given chunk
  function collectDescendantIds(parentId) {
    const ids = new Set()
    function recurse(id) {
      ids.add(id)
      for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].parentIndex === id) {
          recurse(chunks[i].id)
        }
      }
    }
    recurse(parentId)
    return ids
  }

  // Collect all relevant chunk IDs (matched + their subsections)
  const allRelevantIds = new Set()
  for (const r of results) {
    const subtreeIds = collectDescendantIds(r.id)
    for (const id of subtreeIds) allRelevantIds.add(id)
  }

  // Build output for all relevant chunks, in order of appearance
  const outputChunks = chunks.filter(chunk => allRelevantIds.has(chunk.id))

  if (codeOnly) {
    return outputChunks
      .map(chunk => {
        const headingPath = buildHeadingPath(chunks, chunk.id)
        const headingLine = `#`.repeat(chunk.level) + ' ' + chunk.heading
        if (chunk.codeBlocks?.length && chunk.codeBlocks.join('\n')) {
          return `${headingPath}\n\n${headingLine}\n${chunk.codeBlocks.join('\n\n')}`
        }
        return null
      })
      .filter(Boolean)
      .join('\n---\n')
  } else {
    return outputChunks
      .map(chunk => {
        const headingPath = buildHeadingPath(chunks, chunk.id)
        return `${headingPath}\n\n${chunk.content}`
      })
      .join('\n---\n')
  }
}
