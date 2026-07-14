import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const embeddingsDir = path.join(__dirname, '..', 'embeddings')

export const EMBEDDING_IDS = ['code-chunks', 'release-chunks']

async function checkFilesExist(jsonPath, binPath) {
  const [jsonExists, binExists] = await Promise.all([
    fs
      .access(jsonPath)
      .then(() => true)
      .catch(() => false),
    fs
      .access(binPath)
      .then(() => true)
      .catch(() => false)
  ])

  return jsonExists && binExists
}

export async function downloadEmbeddingsById(id) {
  const etagFilePath = path.join(embeddingsDir, `${id}.etag`)
  const storedEtag = await fs.readFile(etagFilePath, 'utf-8').catch(() => null)

  try {
    await fs.mkdir(embeddingsDir, { recursive: true })
    const jsonPath = path.join(embeddingsDir, `${id}.json`)
    const binPath = path.join(embeddingsDir, `${id}.bin`)

    const filesExist = await checkFilesExist(jsonPath, binPath)

    const headers = {}
    if (storedEtag) {
      headers['If-None-Match'] = storedEtag
    }

    const jsonResponse = await fetch(`https://cap.cloud.sap/resources/embeddings/${id}.json`, { headers })

    if (jsonResponse.status === 304) {
      return { etag: storedEtag, updated: false }
    }

    if (!jsonResponse.ok) {
      if (filesExist) {
        return { etag: storedEtag, updated: false }
      }
      throw new Error(`Failed to download JSON: ${jsonResponse.status} ${jsonResponse.statusText}`)
    }

    const newEtag = jsonResponse.headers.get('etag')

    if (storedEtag && newEtag && storedEtag.trim() === newEtag.trim()) {
      return { etag: storedEtag, updated: false }
    }

    const jsonData = await jsonResponse.arrayBuffer()

    const binResponse = await fetch(`https://cap.cloud.sap/resources/embeddings/${id}.bin`, { headers })

    if (!binResponse.ok) {
      if (filesExist) {
        return { etag: storedEtag, updated: false }
      }
      throw new Error(`Failed to download BIN: ${binResponse.status} ${binResponse.statusText}`)
    }

    const binData = await binResponse.arrayBuffer()

    const tempJsonPath = path.join(embeddingsDir, `${id}.json.tmp`)
    const tempBinPath = path.join(embeddingsDir, `${id}.bin.tmp`)

    try {
      await fs.writeFile(tempJsonPath, Buffer.from(jsonData))
      await fs.writeFile(tempBinPath, Buffer.from(binData))

      await fs.rename(tempJsonPath, jsonPath)
      await fs.rename(tempBinPath, binPath)

      if (newEtag) {
        await fs.writeFile(etagFilePath, newEtag)
      }
    } catch (writeError) {
      try {
        await fs.unlink(tempJsonPath).catch(() => {})
        await fs.unlink(tempBinPath).catch(() => {})
      } catch {
        // Ignore cleanup errors
      }

      if (filesExist) {
        return { etag: storedEtag, updated: false }
      }
      throw writeError
    }

    return { etag: newEtag, updated: true }
  } catch (error) {
    const jsonPath = path.join(embeddingsDir, `${id}.json`)
    const binPath = path.join(embeddingsDir, `${id}.bin`)

    const filesExist = await checkFilesExist(jsonPath, binPath)

    if (filesExist) {
      return { etag: storedEtag, updated: false }
    } else {
      throw error
    }
  }
}

export async function downloadEmbeddings(ids = EMBEDDING_IDS) {
  const settled = await Promise.allSettled(downloadEmbeddingsById)
  return settled.reduce((resultsById, result, idx) => {
    if (result.status === 'fulfilled') resultsById[ids[idx]] = result.value
    else resultsById[ids[idx]] = { error: result.reason.message }
    return resultsById
  }, {})
}
