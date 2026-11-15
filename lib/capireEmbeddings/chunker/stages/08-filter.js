import { formatEmbeddingText } from '../../createCapireEmbeddings.js'

function getCategory(source) {
  if (!source) return ''
  const match = source.match(/\/docs\/([^/]+)/)
  return match ? match[1] : ''
}

// True when the body consists entirely of ######-slug anchor lines (no real prose).
function isAnchorOnlyBody(body) {
  let sawSlug = false
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    if (/^#{4,6}\s+\S/.test(t)) {
      sawSlug = true
      continue
    }
    return false
  }
  return sawSlug
}

// True when the body carries no retrievable information.
function isValuelessBody(b) {
  if (/```/.test(b)) return false
  if (/(^|[^!])\[[^\]]*\]\([^)]*\)/.test(b)) return false
  if (/^(will come soon|coming soon|tbd|to be (written|done|added))\.?$/i.test(b.trim()))
    return true
  if (/^this documentation is not (complete|available) yet/i.test(b.trim())) return true
  const stripped = b
    .replace(/!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '')
    .replace(/<\/?[A-Za-z][^>]*\/?>/g, '')
    .replace(/\{\.[a-z-]+\}/gi, '')
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/\bTODO\b/g, '')
    .replace(/[\s#>*_|()-]/g, '')
    .trim()
  return stripped.length === 0
}

// True when the body is a single redirect link with no surrounding prose.
function isRedirectStub(b) {
  if (/```/.test(b)) return false
  if (/^\s*[-*+]\s/m.test(b)) return false
  if (/^\s*\|/m.test(b)) return false
  const links = b.match(/\[[^\]]*\]\([^)]*\)/g)
  if (!links || links.length !== 1) return false
  if (/^\[As in /i.test(links[0])) return false
  const stripped = b
    .replace(/!?\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '')
    .replace(/[\s#>*_|.-]/g, '')
    .trim()
  return stripped === ''
}

export function filter(chunks, config) {
  const dropped = {
    releases: 0,
    emptyBody: 0,
    anchorOnlyBody: 0,
    valueless: 0,
    redirectStub: 0,
    toSmallBody: 0,
    duplicates: 0
  }

  const kept = []
  for (const chunk of chunks) {
    if (getCategory(chunk.source) === 'releases') {
      dropped.releases++
      continue
    }

    const body = (chunk.displayBody ?? '').trim()
    if (body.length === 0) {
      dropped.emptyBody++
      continue
    }

    if (isAnchorOnlyBody(body)) {
      dropped.anchorOnlyBody++
      continue
    }

    if (isValuelessBody(body)) {
      dropped.valueless++
      continue
    }

    if (isRedirectStub(body)) {
      dropped.redirectStub++
      continue
    }

    const bodyTokens = config.measure(body)
    if (bodyTokens < config.minTokens) {
      dropped.toSmallBody++
      continue
    }

    kept.push(chunk)
  }

  // Remove identical embedding and display text under multiple anchors.
  // Keep different headings, display context, split fragments, and runtime labels.
  const seen = new Map()
  const outputFilter = kept.filter((c) => {
    const key = JSON.stringify([c.label ?? '', formatEmbeddingText(c).trim(), c.displayBody.trim()])
    if (seen.has(key)) {
      dropped.duplicates++
      return false
    }
    seen.set(key, true)
    return true
  })

  for (const key in dropped) {
    if (dropped[key]) console.log(`[filter] dropped ${dropped[key]} ${key} chunks`)
  }

  return outputFilter
}
