import fs from 'fs/promises'
import path from 'path'
import calculateEmbeddings, { createEmbeddings, getActiveEmbeddingsDir } from './calculateEmbeddings.js'
import { buildFTS5Index, queryFTS5, toFts5Query } from './fts5.js'

export { createEmbeddings }

export async function loadChunks(id, dir = getActiveEmbeddingsDir()) {
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
    const { dim, chunks, count, metadata, model } = meta

    // Validate metadata structure
    if (!dim || !chunks || !Array.isArray(chunks)) {
      _throwCorruptedError()
    }

    if (count !== undefined && count !== chunks.length) {
      _throwCorruptedError()
    }

    // Optional parallel metadata array — must be the same length if present.
    if (metadata !== undefined) {
      if (!Array.isArray(metadata) || metadata.length !== chunks.length) {
        _throwCorruptedError()
      }
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

      const entry = { content: content, embeddings }
      if (metadata) entry.meta = metadata[i]
      return entry
    })

    if (model) result.model = model

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

export async function getEmbeddings(text, model) {
  const res = await calculateEmbeddings(text, model)
  return res
}

export async function searchEmbeddings(query, chunks) {
  const search = await getEmbeddings(query, chunks?.model)
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

// Hybrid search: semantic cosine similarity + BM25 keyword search combined via
// weighted Reciprocal Rank Fusion. Default weights follow the Anthropic
// contextual-retrieval recommendation: 80% semantic, 20% BM25.
// nCandidates controls how many top results each signal contributes before fusion.
export async function hybridSearch(query, chunks, { semanticWeight = 0.8, bm25Weight = 0.2, nCandidates = 150 } = {}) {
  const queryVec = await getEmbeddings(query, chunks?.model)

  // Semantic rankings by cosine similarity
  const semScored = chunks.map((chunk, i) => ({ i, score: cosineSimilarity(queryVec, chunk.embeddings) }))
  semScored.sort((a, b) => b.score - a.score)
  const semRank = new Map(semScored.slice(0, nCandidates).map(({ i }, rank) => [i, rank]))

  // BM25 rankings via SQLite FTS5 — index built in-memory from chunk content
  const ftsDb = buildFTS5Index(chunks)
  const bm25Results = queryFTS5(ftsDb, toFts5Query(query), nCandidates)
  ftsDb.close()
  const bm25Rank = new Map(bm25Results.map(({ idx }, rank) => [idx, rank]))

  // Weighted RRF: score = semanticWeight / (rank + 1)  +  bm25Weight / (rank + 1)
  const candidates = new Set([...semRank.keys(), ...bm25Rank.keys()])
  const fused = []
  for (const i of candidates) {
    const semR = semRank.has(i) ? semanticWeight / (semRank.get(i) + 1) : 0
    const bm25R = bm25Rank.has(i) ? bm25Weight / (bm25Rank.get(i) + 1) : 0
    fused.push({ ...chunks[i], similarity: semR + bm25R })
  }
  fused.sort((a, b) => b.similarity - a.similarity)
  return fused
}
