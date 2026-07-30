import crypto from 'crypto'

// Stable identifier scheme for eval ground truth.
//
// The published chunk store (embeddings/code-chunks.json) holds only chunk TEXT
// — there is no built-in id, and the array index is volatile (it shifts on every
// corpus re-index). We therefore derive a STABLE id from the chunk content:
//
//   docId = "<label>#<sha1(text)[:8]>"
//
// - sha1(text)[:8] is deterministic, collision-free across distinct chunks, and
//   survives reordering: the same text yields the same id regardless of position.
// - <label> is a short human-readable slug derived from the chunk's first-line
//   breadcrumb (e.g. "getting-started-initial-setup"), purely for readability in
//   reports. It is NOT the identity — the hash is. Two chunks with the same
//   breadcrumb still get distinct ids via the hash.
//
// relevant_doc_ids in the golden set and retrieved_ids from the retriever are
// both expressed in this id space, so scoring is exact set/rank math.

export function hashText(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 8)
}

export function labelFor(text) {
  const first = text.split('\n')[0] || ''
  // Prefer the breadcrumb portion before any "Source:" marker.
  const crumb = first.split(/Source:/i)[0]
  const slug = crumb
    .toLowerCase()
    .replace(/[>]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
  return slug || 'chunk'
}

export function docIdFor(text) {
  return `${labelFor(text)}#${hashText(text)}`
}

// Build the chunk-id -> chunk-text map for the current index.
// Returns { ids: string[], byId: Map<id, text> }.
// Throws on a hash collision between two DIFFERENT texts (should never happen).
export function buildIdMap(chunks) {
  const byId = new Map()
  const ids = []
  for (const text of chunks) {
    const id = docIdFor(text)
    const existing = byId.get(id)
    if (existing !== undefined && existing !== text) {
      throw new Error(`Stable-id collision on ${id} between two different chunks`)
    }
    if (existing === undefined) {
      byId.set(id, text)
      ids.push(id)
    }
  }
  return { ids, byId }
}
