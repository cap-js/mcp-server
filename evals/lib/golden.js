import cds from '@sap/cds'
import { readJsonOrNull } from './util.js'

const { SELECT } = cds.ql

// Load the golden set from disk, or null when the file does not exist.
export async function loadGolden(p) {
  return readJsonOrNull(p)
}

// Structural validation of the golden set. Returns human-readable problem
// strings ([] = valid); catches malformed labels that would crash the run or
// silently skew scoring.
export function validateGolden(questions) {
  const problems = []
  const seenIds = new Set()
  questions.forEach((q, i) => {
    const where = q && q.id ? `question "${q.id}"` : `question #${i + 1}`
    if (!q || typeof q !== 'object') {
      problems.push(`${where}: not an object`)
      return
    }
    if (typeof q.id !== 'string' || !q.id) problems.push(`${where}: missing string "id"`)
    else if (seenIds.has(q.id)) problems.push(`${where}: duplicate id`)
    else seenIds.add(q.id)
    if (typeof q.question !== 'string' || !q.question.trim())
      problems.push(`${where}: missing non-empty "question"`)
    if (!Array.isArray(q.relevant_doc_ids))
      problems.push(`${where}: "relevant_doc_ids" must be an array`)
    else if (q.relevant_doc_ids.length === 0)
      problems.push(`${where}: "relevant_doc_ids" is empty (no ground truth)`)
    else {
      q.relevant_doc_ids.forEach((entry, j) => {
        const at = `entry #${j + 1}`
        if (Array.isArray(entry)) {
          if (entry.length === 0)
            problems.push(`${where}: "relevant_doc_ids" ${at} is an empty OR-group`)
          else if (entry.some((id) => typeof id !== 'string' || !id))
            problems.push(`${where}: "relevant_doc_ids" ${at} contains a non-string/empty id`)
        } else if (typeof entry !== 'string' || !entry) {
          problems.push(`${where}: "relevant_doc_ids" contains a non-string/empty id`)
        }
      })
    }
  })
  return problems
}

// Pre-flight: every relevant_doc_id must exist in the current index. For an
// OR-group, each alternate is checked independently — a stale alternate is
// still worth flagging even if the group has valid siblings.
export async function preflight(goldenQuestions, sourceDb) {
  const pairs = goldenQuestions.flatMap((q) =>
    q.relevant_doc_ids.flatMap((e) =>
      (Array.isArray(e) ? e : [e]).map((doc_id) => ({ question: q.id, doc_id }))
    )
  )
  const allIds = [...new Set(pairs.map((p) => p.doc_id))]
  const found = await sourceDb.run(
    SELECT('source')
      .from('SourceDocs')
      .where({ source: { in: allIds } })
  )
  const foundSources = new Set(found.map((r) => r.source))
  return pairs.filter((p) => !foundSources.has(p.doc_id))
}
