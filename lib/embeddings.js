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
    // Just re-throw all errors since embeddings are pre-shipped
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

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0)
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
  return dot / (normA * normB)
}
