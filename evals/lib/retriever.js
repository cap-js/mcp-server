import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs/promises'
import { resolveIds, buildIdMap, buildTextMap } from './ids.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..', '..') // evals/lib/ → repo root
const chunksJsonPath = path.join(repoRoot, 'embeddings', 'code-chunks.json')

async function readCorpus(jsonPath = chunksJsonPath) {
  const meta = JSON.parse(await fs.readFile(jsonPath, 'utf8'))
  if (!meta || !Array.isArray(meta.chunks)) {
    throw new Error(`Corrupt or missing corpus at ${jsonPath}`)
  }
  return meta.chunks
}

// Distinct doc ids in the current index. Used by the pre-flight stale-id check
// and the header count. `corpusPath` overridable for tests.
export async function loadIndex(corpusPath) {
  const { ids, idSet } = buildIdMap(await readCorpus(corpusPath))
  return { ids, idSet, count: ids.length }
}

// Map of id → chunk text for the current corpus (for compare's content lookup).
export async function loadChunkText(corpusPath) {
  return buildTextMap(await readCorpus(corpusPath))
}

// Reaches search_docs through its handler (like an MCP client), not its
// internals, so the eval measures the tool's real behaviour. The runner can
// inject a fixture instead. search_docs joins top-`maxResults` chunks with
// '\n---\n'; we split and resolve each chunk to its corpus-consistent id in rank
// order (no dedup). A URL-less continuation chunk keeps its slot and is matched
// by text back to its true corpus `#generated-anker-N` id (resolves in compare).
// `deps` ({ searchDocs, corpusPath }) is a test seam for the real ONNX/corpus I/O.
export async function makeDefaultRetriever(k, deps = {}) {
  const searchDocs = deps.searchDocs || (await import('../../lib/tools.js')).default.search_docs
  const corpus = await readCorpus(deps.corpusPath)
  return async function retrieve(question) {
    const out = await searchDocs.handler({ query: question, maxResults: k })
    if (!out) return []
    return resolveIds(out.split('\n---\n'), corpus)
  }
}
