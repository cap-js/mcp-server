import MiniSearch from 'minisearch'

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
        id: i,
        heading,
        body,
        code,
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
  let results = miniSearch.search('boudn action')
  const filtered = []
  for (let i = 0; i < 5; i++) {
    filtered[i] = results[i]
  }
  return results
}
