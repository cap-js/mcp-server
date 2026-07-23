import { loadChunks, searchEmbeddings } from './embeddings.js'
import { downloadEmbeddingsById } from './downloadEmbeddings.js'

const offline = process.argv.includes('--offline') || process.env.CDS_MCP_OFFLINE === 'true'

let downloadPromise = offline ? null : downloadEmbeddingsById('code-chunks')
downloadPromise?.catch(() => {})

export default async function searchMarkdownDocs(query, maxResults = 10) {
  if (downloadPromise) await downloadPromise

  async function searchWithRetry(retryCount = 0) {
    try {
      const chunks = await loadChunks('code-chunks')
      const results = (await searchEmbeddings(query, chunks)).slice(0, maxResults)
      return results.map(r => r.content).join('\n---\n')
    } catch (error) {
      if (error.code === 'EMBEDDINGS_CORRUPTED' && retryCount < 2) {
        if (offline) throw error
        downloadPromise = downloadEmbeddingsById('code-chunks')
        downloadPromise.catch(() => {})
        await downloadPromise
        return searchWithRetry(retryCount + 1)
      }

      throw error
    }
  }

  return searchWithRetry()
}
