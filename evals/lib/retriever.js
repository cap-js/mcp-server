import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs/promises'
import { docIdFor, buildIdMap } from './ids.js'

const here = path.dirname(fileURLToPath(import.meta.url))
// this file lives in evals/lib/ → repo root is two levels up
const repoRoot = path.join(here, '..', '..')
const chunksJsonPath = path.join(repoRoot, 'embeddings', 'code-chunks.json')

// Load the current index's chunk texts + stable-id map (no embeddings needed
// for the id map itself). Used by both the retriever and the pre-flight check.
export async function loadIndex() {
  const raw = await fs.readFile(chunksJsonPath, 'utf8')
  const meta = JSON.parse(raw)
  if (!meta || !Array.isArray(meta.chunks)) {
    throw new Error(`Corrupt or missing chunk store at ${chunksJsonPath}`)
  }
  const { ids, byId } = buildIdMap(meta.chunks)
  return {
    chunks: meta.chunks,
    ids, // all stable ids in the current index
    byId, // id -> text
    idSet: new Set(ids),
    count: meta.count ?? meta.chunks.length,
    dim: meta.dim
  }
}

// Default retriever binding: calls the REAL retrieval path (cosine similarity
// over the pre-built embeddings, same code search_docs uses) and maps each
// ranked result to its stable id. Returns ranked ids, best-first.
//
// Kept pluggable: the runner accepts any `retrieve(question) -> string[]`, so a
// deterministic fixture retriever can be injected in tests.
export async function makeDefaultRetriever() {
  // Import the production retrieval internals lazily so that pure-metric tests
  // (which inject a fixture retriever) never load the ONNX model.
  // Production lib lives at the repo root: evals/lib/ → ../../lib/
  const { loadChunks, searchEmbeddings } = await import('../../lib/embeddings.js')
  const chunks = await loadChunks('code-chunks')
  return async function retrieve(question) {
    const scored = await searchEmbeddings(question, chunks) // sorted desc by similarity
    return scored.map(c => docIdFor(c.content))
  }
}
