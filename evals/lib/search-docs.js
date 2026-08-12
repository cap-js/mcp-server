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
// and the header count. `corpusPath` overridable for tests. `sourceIndex` lets a
// breadcrumb-keyed (LLM-summary) corpus resolve to doc URLs.
export async function loadIndex(corpusPath, sourceIndex = null) {
  const { ids, idSet } = buildIdMap(await readCorpus(corpusPath), sourceIndex)
  return { ids, idSet, count: ids.length }
}

// Map of id → chunk text for the current corpus (for compare's content lookup).
export async function loadChunkText(corpusPath, sourceIndex = null) {
  return buildTextMap(await readCorpus(corpusPath), sourceIndex)
}

// Reaches search_docs through its handler (like an MCP client), not its
// internals. `deps` ({ searchDocs, corpusPath, sourceIndex }) is a test seam.
// Splits the '\n---\n'-joined output into per-slot ids (no dedup) resolved
// corpus-consistent; `retrieve.lastTexts` holds each slot's raw text.
export async function makeSearchDocsRunner(k, deps = {}) {
  const searchDocs = deps.searchDocs || (await import('../../lib/tools.js')).default.search_docs
  const corpus = await readCorpus(deps.corpusPath)
  const sourceIndex = deps.sourceIndex || null
  const retrieve = async function (question) {
    const out = await searchDocs.handler({ query: question, maxResults: k })
    const { ids, texts } = resolveIds(out ? out.split('\n---\n') : [], corpus, sourceIndex)
    retrieve.lastTexts = texts
    return ids
  }
  return retrieve
}
