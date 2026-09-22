import fs from 'fs/promises'
import path from 'path'
import { resolveIds } from './ids.js'
import tools from '../../lib/tools.js'

export async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export async function makeSearchDocsRunner(k, sourceDb) {
  return async function (q) {
    const out = await tools.search_docs.handler({ query: q.question, maxResults: k })
    return resolveIds(out ? out.split('\n---\n') : [], q, sourceDb)
  }
}

export async function retrieveAll(golden, retrieve) {
  const perQuestionRaw = []
  for (const q of golden.questions) {
    const resolvedChunk = await retrieve(q)
    perQuestionRaw.push({
      id: q.id,
      question: q.question,
      relevant_doc_ids: q.relevant_doc_ids,
      retrievedIds: resolvedChunk
    })
  }
  return perQuestionRaw
}

export async function readCapireVersion(dir) {
  if (!dir) return undefined
  try {
    return (await fs.readFile(path.join(dir, '_capire_version'), 'utf8')).trim() || undefined
  } catch {
    try {
      return (await fs.readFile(path.join(dir, '..', '..', '_capire_version'), 'utf8')).trim() || undefined
    } catch {
      return undefined
    }
  }
}

export async function findEmbeddingDirs(root) {
  const results = []
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    if (entries.some(e => e.isFile() && e.name === 'code-chunks.json')) { results.push(dir); return }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name))
    }
  }
  await walk(root)
  return results.sort()
}
