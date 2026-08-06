// Doc identity for eval ground truth: the `Source:` URL from a chunk's first
// line (which already carries the #section anchor). Pure string parsing,
// re-index-stable — only result RANK comes from embeddings.
//   "Getting Started > Initial Setup > Source: https://cap.cloud.sap/docs/get-started/#initial-setup"
// Chunks without a Source: URL fall back to a synthetic capire:// URL derived
// from the breadcrumb text, so they remain retrievable.

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// The Source: URL from a chunk's first line, or a synthetic capire:// URL
// derived from the breadcrumb when no Source: is present.
export function parseId(text) {
  const first = (text || '').split('\n')[0] || ''
  const m = first.match(/Source:\s*(\S+)/i)
  if (m) return m[1]
  // Fallback: synthesize a stable id from the breadcrumb text before Source:
  // (or the whole first line if there is no Source: marker).
  const crumb = first.split(/Source:/i)[0].trim() || first.trim()
  const slug = slugify(crumb)
  return slug ? `capire://generated/${slug}` : null
}

// Yield [id, text] per chunk in order. A URL-less continuation chunk inherits
// the previous chunk's page URL with a `#generated-anker-N` suffix (verbose so
// it's clearly synthesized) instead of being dropped; a leading URL-less chunk
// (no predecessor) is skipped.
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

// Per-slot { ids, texts } for a retrieved chunk sequence (no dedup, aligned).
// Ids are resolved corpus-consistent by matching each chunk's text to the corpus
// (so a #generated-anker id matches buildIdMap's), falling back to the local id.
export function resolveIds(chunks, corpusChunks) {
  const idByText = new Map()
  for (const [id, text] of chunkEntries(corpusChunks)) {
    if (!idByText.has(text)) idByText.set(text, id)
  }
  const ids = []
  const texts = []
  for (const [localId, text] of chunkEntries(chunks)) {
    ids.push(idByText.get(text) || localId)
    texts.push(text)
  }
  return { ids, texts }
}

// Distinct corpus ids, in order (chunks sharing an id collapse to the first).
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

// id → chunk text for the corpus (first occurrence wins), to resolve a report's
// retrieved ids back to content.
export function buildTextMap(chunks) {
  const map = new Map()
  for (const [id, text] of chunkEntries(chunks)) {
    if (!map.has(id)) map.set(id, text)
  }
  return map
}
