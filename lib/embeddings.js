import { pipeline, env } from '@huggingface/transformers'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EMBEDDINGS_DIR = path.join(__dirname, '..', 'embeddings')

const MiniLM = (async () => {
  const packageName = 'Xenova'
  const modelName = 'all-MiniLM-L6-v2'
  const loadModel = () =>
    pipeline('feature-extraction', packageName + '/' + modelName, {
      dtype: 'fp32'
    })
  try {
    return await loadModel()
  } catch {
    // in case the model cannot be loaded because of corrupted files, clear the cache and try again
    await fs.rm(path.join(env.cacheDir, packageName, modelName), {
      recursive: true,
      force: true
    })
    return await loadModel()
  }
})()

export async function loadChunks(id, dir = EMBEDDINGS_DIR) {
  const metaRaw = await fs.readFile(`${dir}/${id}-chunks.json`, 'utf-8')
  const meta = JSON.parse(metaRaw)
  const { dim, chunks } = meta

  const buffer = await fs.readFile(`${dir}/${id}-chunks.bin`)
  const flatEmbeddings = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4)

  return chunks.map((content, i) => {
    const embeddings = flatEmbeddings.slice(i * dim, (i + 1) * dim)
    return { content: content, embeddings }
  })
}

export async function getEmbeddings(text) {
  const extractor = await MiniLM
  const embedding = await extractor(text, { pooling: 'mean', normalize: true })
  return embedding.data
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
  const embeddings = []

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await getEmbeddings(chunks[i])
    embeddings.push(embedding)

    if ((i + 1) % 100 === 0 || i === chunks.length - 1) {
      const percent = Math.round(((i + 1) / chunks.length) * 100)
      // eslint-disable-next-line no-console
      console.log(`Progress: ${i + 1}/${chunks.length} (${percent}%)`)
    }
  }

  await saveChunks(id, chunks, embeddings)
}

export async function saveChunks(id, chunks, embeddings, dir = EMBEDDINGS_DIR) {
  if (!chunks.length) throw new Error('No chunks to save')
  if (!embeddings || !embeddings.length) throw new Error('No embeddings to save')
  if (chunks.length !== embeddings.length) throw new Error('Chunks and embeddings length mismatch')

  const dim = embeddings[0].length
  const count = chunks.length

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true })

  // Flatten embeddings
  const embeddingsPath = `${dir}/${id}-chunks.bin`
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
