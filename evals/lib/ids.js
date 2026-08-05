// Doc identity for eval ground truth: the `Source:` URL from a chunk's first
// line, which already carries the #section anchor. Deterministic pure string
// parsing, re-index-stable — only the RANK of results comes from embeddings.
//   "Getting Started > Initial Setup > Source: https://cap.cloud.sap/docs/get-started/#initial-setup"

// The bare Source: URL of a chunk, or null when the first line has none (a
// page-continuation chunk). Callers resolve URL-less chunks via chunkEntries,
// which inherits the previous chunk's page URL.
export function parseId(text) {
  const first = (text || '').split('\n')[0] || ''
  const m = first.match(/Source:\s*(\S+)/i)
  return m ? m[1] : null
}

// Walk chunks in order and yield [id, text] for each. A chunk with a Source: URL
// uses it; a URL-less continuation chunk inherits the previous chunk's page URL
// with a synthesized `#generated-anker-N` suffix (N = its position in
// that page's continuation run) — deliberately verbose so it's obvious the
// anchor was generated, not a real docs anchor. A leading URL-less chunk (no
// predecessor) is unidentifiable and skipped. Used for the corpus AND retrieved.
function* chunkEntries(chunks) {
  let prevUrl = null
  let contN = 0
  for (const text of chunks) {
    const url = parseId(text)
    if (url) {
      prevUrl = url
      contN = 0
      yield [url, text]
    } else if (prevUrl) {
      contN += 1
      yield [`${prevUrl.split('#')[0]}#generated-anker-${contN}`, text]
    }
  }
}

// Ids for a retrieved chunk sequence, resolved to be CORPUS-CONSISTENT so they
// match buildIdMap's ids (and thus resolve in buildTextMap). A chunk with a
// Source: URL uses it; a URL-less continuation chunk is matched by exact text
// to its corpus entry to recover the true `#generated-anker-N` id, falling back to the
// retrieval-local inherited id when the text isn't found. No dedup (keeps slots).
export function resolveIds(chunks, corpusChunks) {
  const idByText = new Map()
  for (const [id, text] of chunkEntries(corpusChunks)) {
    if (!idByText.has(text)) idByText.set(text, id)
  }
  const entries = [...chunkEntries(chunks)]
  return entries.map(([localId, text]) => idByText.get(text) || localId)
}

// Distinct ids for the whole corpus, in order. Chunks sharing an id (a section
// split without continuation) collapse to the first occurrence.
export function buildIdMap(chunks) {
  const idSet = new Set()
  const ids = []
  for (const [id] of chunkEntries(chunks)) {
    if (idSet.has(id)) continue
    idSet.add(id)
    ids.push(id)
  }
  return { ids, idSet }
}

// Map of id → chunk text for the whole corpus (first occurrence wins, matching
// buildIdMap's dedup). Lets a report's retrieved ids be resolved back to content.
export function buildTextMap(chunks) {
  const map = new Map()
  for (const [id, text] of chunkEntries(chunks)) {
    if (!map.has(id)) map.set(id, text)
  }
  return map
}
