// Doc identity for eval ground truth: the chunk's own `Source:` URL — the FIRST
// `> Source:` line in the chunk (it sits a couple of lines below the heading:
// `## Initial Setup\n\n> Source: /docs/get-started/#initial-setup`). Pure string
// parsing, re-index-stable — only result RANK comes from embeddings.
//
// The live LLM-summary corpus has NO `> Source:` lines — its chunks are keyed by
// a breadcrumb first line ("The Bookshop Sample > Databases"). For those we fall
// back to a breadcrumb→URL map (built from llms-full.txt). A chunk that resolves
// to neither has no id and its slot is dropped (not scored).

const HEADING = /^#{1,6}\s+(.*\S)\s*$/
const SOURCE = /Source:\s*(\S+)/i

// The chunk's own Source: URL — the first `> Source:` line anywhere in the chunk.
export function parseId(text) {
  for (const line of (text || '').split('\n')) {
    const m = line.match(SOURCE)
    if (m) return m[1]
  }
  return null
}

// Resolve a chunk's first-line breadcrumb ("A > B > C") to a doc URL via the
// source index: full-path match first, then leaf-heading. Returns null if absent
// or if no index. Used only when the chunk has no `> Source:` line of its own.
function breadcrumbId(text, sourceIndex) {
  if (!sourceIndex) return null
  const first = (text || '').split('\n')[0].trim().toLowerCase()
  if (!first) return null
  const full = sourceIndex.byBreadcrumb?.[first]
  if (full) return full
  const leaf = first.split(' > ').pop()
  return sourceIndex.byLeaf?.[leaf] || null
}

// The chunk's primary id: its own Source: URL, else its breadcrumb resolved via
// the source index, else null.
export function chunkId(text, sourceIndex = null) {
  return parseId(text) || breadcrumbId(text, sourceIndex)
}

// Every doc section a chunk covers, in order (deduped). A corpus chunk is a slice
// of llms-full.txt that may span several headings; each heading normally carries
// its own `> Source:` line in the body, but a chunk boundary can split a heading
// from its Source line. We therefore:
//   1. collect every `Source:` URL literally present in the chunk, then
//   2. for any heading whose Source line was split off, resolve it via the
//      page-scoped source tree (built from llms-full.txt by build-source-tree.js), and
//   3. if the chunk has NO Source line at all (LLM-summary corpus), resolve its
//      breadcrumb first line via the breadcrumb→URL map.
// `sourceIndex` is { tree, byHeadingInPage, byBreadcrumb, byLeaf } or null.
export function resolveChunkIds(text, sourceIndex = null) {
  const lines = (text || '').split('\n')
  const ids = []
  const seen = new Set()
  const add = url => {
    if (url && !seen.has(url)) {
      seen.add(url)
      ids.push(url)
    }
  }

  // Page context for tree lookups: the page of the first Source URL we see.
  let page = null
  let pendingHeading = null
  const flushPending = () => {
    if (!pendingHeading) return
    // Heading whose Source line was split off → resolve via the source tree.
    const byHeading = sourceIndex && page ? sourceIndex.byHeadingInPage?.[page] : null
    const resolved = byHeading ? byHeading[pendingHeading.trim().toLowerCase()] : null
    if (resolved) add(resolved)
    pendingHeading = null
  }
  for (const line of lines) {
    const h = HEADING.exec(line)
    if (h) {
      flushPending() // a new heading arrived before the previous one's Source line
      pendingHeading = h[1]
      continue
    }
    const s = line.match(SOURCE)
    if (s) {
      // Source line present in the body → use it verbatim.
      add(s[1])
      if (!page) page = s[1].split('#')[0]
      pendingHeading = null
    }
  }
  flushPending() // trailing heading with no Source line

  // No Source line anywhere → LLM-summary chunk keyed by breadcrumb.
  if (ids.length === 0) add(breadcrumbId(text, sourceIndex))
  return ids
}

// Yield [id, text] per chunk in order. A chunk's id is its Source: URL, else its
// breadcrumb resolved via the source index; a chunk that resolves to neither is
// skipped (not scored).
function* chunkEntries(chunks, sourceIndex = null) {
  for (const text of chunks) {
    const id = chunkId(text, sourceIndex)
    if (id) yield [id, text]
  }
}

// Per-slot { ids, texts } for a retrieved chunk sequence (no dedup, aligned).
// Ids are resolved corpus-consistent by matching each chunk's text to the corpus,
// falling back to the local id. `sourceIndex` lets breadcrumb-keyed (LLM-summary)
// corpora resolve too.
export function resolveIds(chunks, corpusChunks, sourceIndex = null) {
  const idByText = new Map()
  for (const [id, text] of chunkEntries(corpusChunks, sourceIndex)) {
    if (!idByText.has(text)) idByText.set(text, id)
  }
  const ids = []
  const texts = []
  for (const [localId, text] of chunkEntries(chunks, sourceIndex)) {
    ids.push(idByText.get(text) || localId)
    texts.push(text)
  }
  return { ids, texts }
}

// Distinct corpus ids, in order (chunks sharing an id collapse to the first).
export function buildIdMap(chunks, sourceIndex = null) {
  const idSet = new Set()
  const ids = []
  for (const [id] of chunkEntries(chunks, sourceIndex)) {
    if (idSet.has(id)) continue
    idSet.add(id)
    ids.push(id)
  }
  return { ids, idSet }
}

// id → chunk text for the corpus (first occurrence wins), to resolve a report's
// retrieved ids back to content.
export function buildTextMap(chunks, sourceIndex = null) {
  const map = new Map()
  for (const [id, text] of chunkEntries(chunks, sourceIndex)) {
    if (!map.has(id)) map.set(id, text)
  }
  return map
}
