import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs/promises'
import { resolveIds } from './ids.js'
import tools from '../../lib/tools.js'

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

// Map of id → chunk text for the current corpus (for compare's content lookup).
export async function loadChunkText(corpusPath, sourceIndex = null) {
  return buildTextMap(await readCorpus(corpusPath), sourceIndex)
}

export async function makeSearchDocsRunner(k, sourceMap) {
  const retrieve = async function (question) {
    const out = await tools.search_docs.handler({ query: question, maxResults: k })
    return resolveIds(out ? out.split('\n---\n') : [], sourceMap)
  }
  return retrieve
}
