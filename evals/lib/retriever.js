import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs/promises'
import { parseId, buildIdMap } from './ids.js'

const here = path.dirname(fileURLToPath(import.meta.url))
// this file lives in evals/lib/ → repo root is two levels up
const repoRoot = path.join(here, '..', '..')
const chunksJsonPath = path.join(repoRoot, 'embeddings', 'code-chunks.json')

// The set of doc ids present in the current index. Parsed (url#breadcrumb) from
// the corpus first-lines — no embeddings needed for identity. Used by the
// pre-flight check (are the golden ids still present?) and the header count.
export async function loadIndex() {
  const raw = await fs.readFile(chunksJsonPath, 'utf8')
  const meta = JSON.parse(raw)
  if (!meta || !Array.isArray(meta.chunks)) {
    throw new Error(`Corrupt or missing corpus at ${chunksJsonPath}`)
  }
  const { ids, idSet } = buildIdMap(meta.chunks)
  return {
    ids, // all distinct doc ids in the current index
    idSet,
    count: ids.length // distinct docs (what the report header shows)
  }
}

// search_docs returns the top-`maxResults` chunk contents joined by '\n---\n'.
// We split that back into chunks and parse each chunk's id (<url>#<breadcrumb>),
// in rank order, WITHOUT deduping — each of the K returned chunks is one result
// slot (a page appearing N times fills N slots). Unidentifiable chunks keep a
// null id so positions/counts still line up with what the tool returned.
//
// Kept pluggable: the runner accepts any `retrieve(question) -> string[]`, so a
// deterministic fixture retriever can be injected in tests.
export async function makeDefaultRetriever(k) {
  // Import the tool the same way an MCP client reaches it — its handler — rather
  // than the retrieval internals. Repo root: evals/lib/ → ../../
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
