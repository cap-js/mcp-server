import fs from 'fs/promises'
import Fuse from 'fuse.js'

export async function searchMarkdownDocs(filePath, query, maxResults = 5) {
  const content = await fs.readFile(filePath, 'utf-8')

  const headingRegex = /^(#{1,6}) (.+)$/gm
  const indices = []
  let match

  while ((match = headingRegex.exec(content)) !== null) {
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
    const end = i + 1 < indices.length ? indices[i + 1].index : content.length
    const chunkText = content.slice(start, end).trim()

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
        parentIndex,
        parentHeading: parentIndex !== null ? indices[parentIndex].heading : null
      })
    }
  }

  // Use Fuse.js for fuzzy search
  const fuse = new Fuse(chunks, {
    keys: [
      { name: 'heading', weight: 0.4 },
      { name: 'body', weight: 0.2 },
      { name: 'code', weight: 0.4 }
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

  // Only return chunks with body and code, as before
  const prioritized = fuseResults
    .map(({ item }) => item)
    .filter(item => item.fullText && item.fullText.length > 0)
    .slice(0, maxResults)
    .map(item => {
      const parentChain = buildParentHeadingChain(item, chunks).join(' > ')
      if (parentChain) {
        return `${parentChain}\n\n${item.fullText.trim()}`
      } else {
        return item.fullText.trim()
      }
    })
  return prioritized
}

let results = await searchMarkdownDocs('lib/llms-full.txt', 'for update')
