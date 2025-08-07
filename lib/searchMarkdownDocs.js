import { loadChunks, searchEmbeddings } from './embeddings.js'

export default async function searchMarkdownDocs(query, maxResults = 10) {
  const chunks = await loadChunks('code')
  const results = (await searchEmbeddings(query, chunks)).slice(0, maxResults)
  return results.map(r => r.content).join('---')
}
