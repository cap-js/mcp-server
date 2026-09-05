import { loadChunks, searchEmbeddings } from './embeddings.js'
import { main as createEmbeddings } from '../scripts/createEmbeddings.js'

export function formatResult(r) {
  if (!r.meta) return r.content
  const header = Object.entries(r.meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return header ? `${header}\n\n${r.content}` : r.content
}

export default async function searchMarkdownDocs(query, maxResults = 10) {
  async function searchWithRetry(retryCount = 0) {
    try {
      const chunks = await loadChunks('code-chunks')
      const results = (await searchEmbeddings(query, chunks)).slice(0, maxResults)
      return results.map(formatResult).join('\n---\n')
    } catch (error) {
      if ((error.code === 'EMBEDDINGS_CORRUPTED' || error.code === 'ENOENT') && retryCount < 2) {
        await createEmbeddings()
        return searchWithRetry(retryCount + 1)
      }
      throw error
    }
  }

  return searchWithRetry()
}
