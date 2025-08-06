import { pipeline } from '@huggingface/transformers'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS_DIR = path.join(__dirname, '..', 'docs')

export async function loadChunks(dir = DOCS_DIR) {
  const metaRaw = await fs.readFile(`${dir}/chunks.json`, 'utf-8')
  const meta = JSON.parse(metaRaw)
  const { dim, chunks: chunksMeta } = meta

  const buffer = await fs.readFile(`${dir}/embeddings.bin`)
  const flatEmbeddings = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4)

  const chunks = chunksMeta.map((chunkMeta, i) => {
    const embeddings = flatEmbeddings.slice(i * dim, (i + 1) * dim)
    return { ...chunkMeta, embeddings }
  })

  return chunks
}

export async function searchEmbeddings(chunks, keyword) {
  const search = await getEmbeddings(keyword)
  // Compute similarity for all chunks
  const scoredChunks = chunks.map(chunk => ({
    ...chunk,
    similarity: cosineSimilarity(search, chunk.embeddings)
  }))
  // Sort by similarity descending
  scoredChunks.sort((a, b) => b.similarity - a.similarity)
  return scoredChunks
}

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

  await saveChunks(chunks)
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0)
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
  return dot / (normA * normB)
}

async function getEmbeddings(text) {
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' })
  const embedding = await extractor(text, { pooling: 'mean', normalize: true })
  return embedding.data
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
}
