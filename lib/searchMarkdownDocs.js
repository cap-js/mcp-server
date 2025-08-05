import { pipeline } from '@huggingface/transformers'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS_DIR = path.join(__dirname, '..', 'docs')

async function getEmbeddings(text) {
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' })
  const embedding = await extractor(text, { pooling: 'mean', normalize: true })
  return embedding.data
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0)
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
  return dot / (normA * normB)
}

export default async function searchMarkdownDocs(query, maxResults = 5, codeOnly = false) {
  const chunks = await loadChunks()
  let results = await searchEmbeddings(chunks, query, maxResults)

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
  for (const r of results.slice(0, maxResults)) {
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

const createEmbeddings = async () => {
  console.log('creating embeddings')
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
  let i = 1
  for (const chunk of chunks) {
    i++
    if (i % 100 === 0) console.log(i)
    chunk.embeddings = await getEmbeddings(chunk.content)
  }

  await saveChunks(chunks)
}


async function saveChunks(chunks, dir = DOCS_DIR) {
  if (!chunks.length) throw new Error('No chunks to save')

  const dim = chunks[0].embeddings.length
  const count = chunks.length

  // Flatten embeddings
  const embeddingsPath = `${dir}/embeddings.bin`
  const metaPath = `${dir}/chunks.json`

  try {
    await fs.unlink(embeddingsPath)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err // Ignore if file doesn't exist
  }

  try {
    await fs.unlink(metaPath)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  const flatEmbeddings = new Float32Array(count * dim)

  chunks.forEach((chunk, i) => {
    if (!(chunk.embeddings instanceof Float32Array)) {
      throw new Error(`Chunk ${chunk.id} embeddings must be a Float32Array`)
    }
    if (chunk.embeddings.length !== dim) {
      throw new Error(`All embeddings must have same length (chunk ${chunk.id} mismatch)`)
    }
    flatEmbeddings.set(chunk.embeddings, i * dim)
  })

  // Save embeddings binary
  await fs.writeFile(embeddingsPath, Buffer.from(flatEmbeddings.buffer))

  // Save metadata + chunk info (excluding embeddings)
  const chunksMeta = chunks.map(({ id, heading, codeBlocks, content, level, parentIndex }) => ({
    id,
    heading,
    codeBlocks,
    content,
    level,
    parentIndex
  }))

  const meta = { dim, count, chunks: chunksMeta }
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2))

  console.log(`Saved ${count} chunks with embeddings to '${dir}'`)
}

async function loadChunks(dir = DOCS_DIR) {
  const metaRaw = await fs.readFile(`${dir}/chunks.json`, 'utf-8')
  const meta = JSON.parse(metaRaw)
  const { dim, count, chunks: chunksMeta } = meta

  const buffer = await fs.readFile(`${dir}/embeddings.bin`)
  const flatEmbeddings = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4)

  const chunks = chunksMeta.map((chunkMeta, i) => {
    const embeddings = flatEmbeddings.slice(i * dim, (i + 1) * dim)
    return { ...chunkMeta, embeddings }
  })

  return chunks
}

async function searchEmbeddings(chunks, keyword, maxResults = 10) {
  const search = await getEmbeddings(keyword)
  // Compute similarity for all chunks
  const scoredChunks = chunks.map(chunk => ({
    ...chunk,
    similarity: cosineSimilarity(search, chunk.embeddings)
  }))
  // Sort by similarity descending
  scoredChunks.sort((a, b) => b.similarity - a.similarity)
  // Return top maxResults
  return scoredChunks.slice(0, maxResults)
}

const main = async () => {
  // console.time('creating embeddings')
  // await createEmbeddings()
  // console.timeEnd('creating embeddings')
  // console.time('searching embeddings')
  // const searchResult = await searchEmbeddings('testing')
  // console.timeEnd('searching embeddings')
  // console.log('Search Result:', searchResult.map(c => c.content))
  const searchResult = await searchMarkdownDocs('how to configure event hub in nodejs?', 4, false)
  console.log(searchResult)
}

main()
