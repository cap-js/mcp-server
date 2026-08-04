import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs/promises'
import { parseId, buildIdMap } from './ids.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..', '..') // evals/lib/ → repo root
const chunksJsonPath = path.join(repoRoot, 'embeddings', 'code-chunks.json')

// Distinct doc ids in the current index. Used by the pre-flight stale-id check
// and the header count.
export async function loadIndex() {
  const raw = await fs.readFile(chunksJsonPath, 'utf8')
  const meta = JSON.parse(raw)
  if (!meta || !Array.isArray(meta.chunks)) {
    throw new Error(`Corrupt or missing corpus at ${chunksJsonPath}`)
  }
  const { ids, idSet } = buildIdMap(meta.chunks)
  return { ids, idSet, count: ids.length }
}

// Reaches search_docs through its handler (like an MCP client), not its
// internals, so the eval measures the tool's real behaviour. The runner can
// inject a fixture instead. search_docs joins top-`maxResults` chunks with
// '\n---\n'; we split and take each chunk's Source: URL in rank order (no dedup).
export async function makeDefaultRetriever(k) {
  const tools = (await import('../../lib/tools.js')).default
  const searchDocs = tools.search_docs
  return async function retrieve(question) {
    const out = await searchDocs.handler({ query: question, maxResults: k })
    if (!out) return []
    return out.split('\n---\n').map(parseId)
  }
}
