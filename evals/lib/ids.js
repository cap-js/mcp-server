// Doc identity for eval ground truth: "<source-url>#<breadcrumb-slug>", parsed
// from a chunk's first line. Deterministic (pure string parsing) and re-index-
// stable at the page level — only the RANK of results comes from embeddings,
// never identity. First line looks like:
//   "CDS Language & Compiler > Managed Compositions > Source: https://cap.cloud.sap/docs/..."

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[>]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Fallbacks: breadcrumb but no URL → "nourl#<slug>"; neither → null (dropped).
export function parseId(text) {
  const first = (text || '').split('\n')[0] || ''
  const m = first.match(/Source:\s*(\S+)/i)
  const url = m ? m[1] : null
  const crumb = first.split(/Source:/i)[0]
  const slug = slugify(crumb)
  if (url) return `${url}#${slug || 'section'}`
  return slug ? `nourl#${slug}` : null
}

// Distinct ids in the current index. Chunks with the same id (a section split
// across chunks) collapse to one; unidentifiable chunks (null id) are skipped.
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
