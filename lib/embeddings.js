import { pipeline } from '@huggingface/transformers'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS_DIR = path.join(__dirname, '..', 'docs')

// promise, start fetching it asap
const MiniLM = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' })

export async function loadChunks(id, dir = DOCS_DIR) {
  const metaRaw = await fs.readFile(`${dir}/${id}-chunks.json`, 'utf-8')
  const meta = JSON.parse(metaRaw)
  const { dim, chunks: chunksMeta } = meta

  const buffer = await fs.readFile(`${dir}/${id}-embeddings.bin`)
  const flatEmbeddings = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4)

  const chunks = chunksMeta.map((chunkMeta, i) => {
    const embeddings = flatEmbeddings.slice(i * dim, (i + 1) * dim)
    return { ...chunkMeta, embeddings }
  })

  return chunks
}

export async function searchEmbeddings(query, chunks) {
  const search = await getEmbeddings(query)
  // Compute similarity for all chunks
  const scoredChunks = chunks.map(chunk => ({
    ...chunk,
    similarity: cosineSimilarity(search, chunk.embeddings)
  }))
  // Sort by similarity descending
  scoredChunks.sort((a, b) => b.similarity - a.similarity)
  return scoredChunks
}

// Only to be used in scripts, not in production
export async function createEmbeddings(id, chunks) {
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].embeddings = await getEmbeddings(chunks[i].content)
    if ((i + 1) % 100 === 0 || i === chunks.length - 1) {
      const percent = Math.round(((i + 1) / chunks.length) * 100)
      // eslint-disable-next-line no-console
      console.log(`Progress: ${i + 1}/${chunks.length} (${percent}%)`)
    }
  }

  await saveChunks(id, chunks)
}

export async function saveChunks(id, chunks, dir = DOCS_DIR) {
  if (!chunks.length) throw new Error('No chunks to save')

  const dim = chunks[0].embeddings.length
  const count = chunks.length

  // Flatten embeddings
  const embeddingsPath = `${dir}/${id}-embeddings.bin`
  const metaPath = `${dir}/${id}-chunks.json`

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

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0)
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
  return dot / (normA * normB)
}

async function getEmbeddings(text) {
  const extractor = await MiniLM
  const embedding = await extractor(text, { pooling: 'mean', normalize: true })
  return embedding.data
}
