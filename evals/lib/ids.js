// Doc identity for eval ground truth: a deterministic id parsed from a chunk's
// FIRST LINE — no embeddings, no content hashing involved.
//
//   docId = "<source-url>#<breadcrumb-slug>"
//
// A chunk's first line looks like:
//   "CDS Language & Compiler > Managed Compositions ... > Source: https://cap.cloud.sap/docs/releases/2020/july20"
// From it we take:
//   - the Source: URL           → the stable page identity (survives re-index)
//   - the breadcrumb before it  → slugified section identity (granularity)
// giving e.g. "https://cap.cloud.sap/docs/releases/2020/july20#cds-language-compiler-managed-compositions-for".
//
// This is fully deterministic (pure string parsing) and re-index-stable at the
// page level. Only the RANK of retrieved docs still comes from the embedding
// retriever; identity and matching never touch embeddings.
//
// Fallbacks:
//   - chunk has a breadcrumb but no Source: URL → "nourl#<slug>"
//   - chunk has neither                          → null (unidentifiable; dropped)

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[>]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Parse the "<url>#<slug>" id from a chunk's text. Returns null if the chunk has
// neither a Source: URL nor any breadcrumb text to slugify.
export function parseId(text) {
  const first = (text || '').split('\n')[0] || ''
  const m = first.match(/Source:\s*(\S+)/i)
  const url = m ? m[1] : null
  const crumb = first.split(/Source:/i)[0]
  const slug = slugify(crumb)
  if (url) return `${url}#${slug || 'section'}`
  return slug ? `nourl#${slug}` : null
}

// Build the set of ids present in the current index, from the chunk texts.
// Returns { ids: string[], idSet: Set<string> }. Chunks that parse to the same
// id (a section legitimately split across chunks) collapse to one entry; chunks
// with no id are skipped.
export function buildIdMap(chunks) {
  const idSet = new Set()
  const ids = []
  for (const text of chunks) {
    const id = parseId(text)
    if (id === null || idSet.has(id)) continue
    idSet.add(id)
    ids.push(id)
  }
  return { ids, idSet }
}
