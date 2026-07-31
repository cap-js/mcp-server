import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs/promises'
import { parseId, buildIdMap } from './ids.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..', '..') // evals/lib/ → repo root
const chunksJsonPath = path.join(repoRoot, 'embeddings', 'code-chunks.json')

// Distinct doc ids in the current index, parsed (url#breadcrumb) from corpus
// first-lines. Used by the pre-flight stale-id check and the header count.
export async function loadIndex() {
  const raw = await fs.readFile(chunksJsonPath, 'utf8')
  const meta = JSON.parse(raw)
  if (!meta || !Array.isArray(meta.chunks)) {
    throw new Error(`Corrupt or missing corpus at ${chunksJsonPath}`)
  }
  const { ids, idSet } = buildIdMap(meta.chunks)
  return { ids, idSet, count: ids.length }
}

// Reaches search_docs the same way an MCP client would — through its handler,
// not its internals — so the eval measures the tool's real behaviour. Returns
// `retrieve(question) -> string[]`; the runner can inject a fixture instead.
// search_docs returns top-`maxResults` chunks joined by '\n---\n'; we split and
// parse each chunk's id in rank order, no dedup (each chunk = one slot).
export async function makeDefaultRetriever(k) {
  const tools = (await import('../../lib/tools.js')).default
  const searchDocs = tools.search_docs
  return async function retrieve(question) {
    const out = await searchDocs.handler({ query: question, maxResults: k })
    if (!out) return []
    return out
      .split('\n---\n')
      .map(chunk => parseId(chunk))
      .filter(id => id !== null)
  }
}
