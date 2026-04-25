import { loadChunks, searchEmbeddings } from './embeddings.js'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const embeddingsDir = path.join(__dirname, '..', 'embeddings')
const etagPath = path.join(embeddingsDir, 'code-chunks.etag')

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

async function readStoredEtag() {
  try {
    return await fs.readFile(etagPath, 'utf-8')
  } catch {
    return null
  }
}

export async function downloadEmbeddings() {
  try {
    await fs.mkdir(embeddingsDir, { recursive: true })
    const jsonPath = path.join(embeddingsDir, 'code-chunks.json')
    const binPath = path.join(embeddingsDir, 'code-chunks.bin')

    const filesExist = await checkFilesExist(jsonPath, binPath)

    const storedEtag = await readStoredEtag()

    const headers = {}
    if (storedEtag) {
      headers['If-None-Match'] = storedEtag
    }

    const jsonResponse = await fetch('https://cap.cloud.sap/resources/embeddings/code-chunks.json', { headers })

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

    const binResponse = await fetch('https://cap.cloud.sap/resources/embeddings/code-chunks.bin', { headers })

    if (!binResponse.ok) {
      if (filesExist) {
        return { etag: storedEtag, updated: false }
      }
      throw new Error(`Failed to download BIN: ${binResponse.status} ${binResponse.statusText}`)
    }

    const binData = await binResponse.arrayBuffer()

    const tempJsonPath = path.join(embeddingsDir, 'code-chunks.json.tmp')
    const tempBinPath = path.join(embeddingsDir, 'code-chunks.bin.tmp')

    try {
      await fs.writeFile(tempJsonPath, Buffer.from(jsonData))
      await fs.writeFile(tempBinPath, Buffer.from(binData))

      await fs.rename(tempJsonPath, jsonPath)
      await fs.rename(tempBinPath, binPath)

      if (newEtag) {
        await fs.writeFile(etagPath, newEtag)
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
    const jsonPath = path.join(embeddingsDir, 'code-chunks.json')
    const binPath = path.join(embeddingsDir, 'code-chunks.bin')

    const filesExist = await checkFilesExist(jsonPath, binPath)

    if (filesExist) {
      const storedEtag = await readStoredEtag()
      return { etag: storedEtag, updated: false }
    } else {
      throw error
    }
  }
}

let downloadPromise = downloadEmbeddings()

export default async function searchMarkdownDocs(query, maxResults = 10) {
  await downloadPromise

  async function searchWithRetry(retryCount = 0) {
    try {
      const chunks = await loadChunks('code-chunks')
      const results = (await searchEmbeddings(query, chunks)).slice(0, maxResults)
      return results.map(r => r.content).join('\n---\n')
    } catch (error) {
      if (error.code === 'EMBEDDINGS_CORRUPTED' && retryCount < 2) {
        downloadPromise = downloadEmbeddings()
        await downloadPromise
        return searchWithRetry(retryCount + 1)
      }

      throw error
    }
  }

  return searchWithRetry()
}
