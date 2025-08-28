import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import calculateEmbeddings from './calculateEmbeddings.js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function loadChunks(id, dir = path.join(__dirname, '..', 'embeddings')) {
  function _throwCorruptedError() {
    const error = new Error('Corrupted files')
    error.code = 'EMBEDDINGS_CORRUPTED'
    throw error
  }

  try {
    const metaPath = path.join(dir, `${id}.json`)
    const binPath = path.join(dir, `${id}.bin`)

    // Read and parse JSON metadata
    const metaRaw = await fs.readFile(metaPath, 'utf-8')

    let meta
    try {
      meta = JSON.parse(metaRaw)
    } catch {
      _throwCorruptedError()
    }
    const { dim, chunks, count } = meta

    // Validate metadata structure
    if (!dim || !chunks || !Array.isArray(chunks)) {
      _throwCorruptedError()
    }

    if (count !== undefined && count !== chunks.length) {
      _throwCorruptedError()
    }

    // Read binary data
    const buffer = await fs.readFile(binPath)
    const expectedSize = chunks.length * dim * 4 // Float32 = 4 bytes

    if (buffer.length !== expectedSize) {
      _throwCorruptedError()
    }

    let flatEmbeddings
    try {
      flatEmbeddings = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4)
    } catch {
      _throwCorruptedError()
    }

    // Validate that we can create embeddings without errors
    const result = chunks.map((content, i) => {
      if (typeof content !== 'string') {
        _throwCorruptedError()
      }

      const startIndex = i * dim
      const endIndex = (i + 1) * dim

      if (startIndex >= flatEmbeddings.length || endIndex > flatEmbeddings.length) {
        _throwCorruptedError()
      }

      const embeddings = flatEmbeddings.slice(startIndex, endIndex)

      // Check for NaN or infinite values
      for (let j = 0; j < embeddings.length; j++) {
        if (!isFinite(embeddings[j])) {
          _throwCorruptedError()
        }
      }

      return { content: content, embeddings }
    })

    return result
  } catch (error) {
    // If it's a corruption error, delete files and re-throw
    if (error.code === 'EMBEDDINGS_CORRUPTED') {
      // Delete corrupted files
      const metaPath = path.join(dir, `${id}.json`)
      const binPath = path.join(dir, `${id}.bin`)
      const etagPath = path.join(dir, `${id}.etag`)

      await Promise.all([
        fs.unlink(metaPath).catch(() => {}),
        fs.unlink(binPath).catch(() => {}),
        fs.unlink(etagPath).catch(() => {})
      ])

      throw error
    }

    // For other errors (file not found, etc.), just re-throw
    throw error
  }
}

export async function getEmbeddings(text) {
  const res = await calculateEmbeddings(text)
  return res
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
export async function createEmbeddings(id, chunks, dir = path.join(__dirname, '..', 'embeddings')) {
  const embeddings = []

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await getEmbeddings(chunks[i])
    embeddings.push(embedding)
  }

  await saveEmbeddings(id, chunks, embeddings, dir)
}

async function saveEmbeddings(id, chunks, embeddings, dir) {
  if (!chunks.length) throw new Error('No chunks to save')
  if (!embeddings || !embeddings.length) throw new Error('No embeddings to save')
  if (chunks.length !== embeddings.length) throw new Error('Chunks and embeddings length mismatch')

  const dim = embeddings[0].length
  const count = chunks.length

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true })

  // Flatten embeddings
  const embeddingsPath = path.join(dir, `${id}.bin`)
  const metaPath = path.join(dir, `${id}.json`)

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

  embeddings.forEach((embedding, i) => {
    if (!(embedding instanceof Float32Array)) {
      throw new Error(`Embedding ${i} must be a Float32Array`)
    }
    if (embedding.length !== dim) {
      throw new Error(`All embeddings must have same length (embedding ${i} mismatch)`)
    }
    flatEmbeddings.set(embedding, i * dim)
  })

  // Save embeddings binary
  await fs.writeFile(embeddingsPath, Buffer.from(flatEmbeddings.buffer))

  // Save metadata (chunks without embeddings)
  const meta = { dim, count, chunks }
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2))
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0)
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
  return dot / (normA * normB)
}
