// Doc identity for eval ground truth: the `Source:` URL from a chunk's first
// line, which already carries the #section anchor. Deterministic pure string
// parsing, re-index-stable — only the RANK of results comes from embeddings.
//   "Getting Started > Initial Setup > Source: https://cap.cloud.sap/docs/get-started/#initial-setup"

// Throws (rather than dropping) if a chunk has no Source: URL — that's a corrupt
// index entry, and silently skipping it would skew the corpus.
export function parseId(text) {
  const first = (text || '').split('\n')[0] || ''
  const m = first.match(/Source:\s*(\S+)/i)
  if (!m) throw new Error(`parseId: chunk has no "Source:" URL in its first line: ${JSON.stringify(first.slice(0, 120))}`)
  return m[1]
}

// Distinct ids; chunks sharing an id (a section split across chunks) collapse to one.
export function buildIdMap(chunks) {
  const idSet = new Set()
  const ids = []
  for (const text of chunks) {
    const id = parseId(text)
    if (idSet.has(id)) continue
    idSet.add(id)
    ids.push(id)
  }
  return { ids, idSet }
}
