import { getEmbeddings, saveChunks } from './embeddings.js'

export async function createEmbeddings() {
  const input = await fetch('https://cap.cloud.sap/docs/llms-full.txt').then(x => x.text())
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
  for (const chunk of chunks) {
    chunk.embeddings = await getEmbeddings(chunk.content)
  }

  await saveChunks('capire', chunks)
}


