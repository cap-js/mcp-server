function isAnchorOnlyBody(body) {
  let sawSlug = false
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^#{4,6}\s+\S/.test(trimmed)) {
      sawSlug = true
      continue
    }
    return false
  }
  return sawSlug
}

function isValuelessBody(body) {
  if (/```/.test(body) || /(^|[^!])\[[^\]]*\]\([^)]*\)/.test(body)) return false
  if (/^(will come soon|coming soon|tbd|to be (written|done|added))\.?$/i.test(body.trim()))
    return true
  if (/^this documentation is not (complete|available) yet/i.test(body.trim())) return true
  const content = body
    .replace(/!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '')
    .replace(/<\/?[A-Za-z][^>]*\/?>/g, '')
    .replace(/\{\.[a-z-]+\}/gi, '')
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/\bTODO\b/g, '')
    .replace(/[\s#>*_|()-]/g, '')
    .trim()
  return content.length === 0
}

function isRedirectStub(body) {
  if (/```/.test(body) || /^\s*[-*+]\s/m.test(body) || /^\s*\|/m.test(body)) return false
  const links = body.match(/\[[^\]]*\]\([^)]*\)/g)
  if (!links || links.length !== 1 || /^\[As in /i.test(links[0])) return false
  return body
    .replace(/!?\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '')
    .replace(/[\s#>*_|.-]/g, '')
    .trim() === ''
}

export function filterChunks(chunks, config, policy = {}) {
  const dropped = { emptyBody: [], tooSmallBody: [], anchorOnlyBody: [], valueless: [], redirectStub: [], duplicates: [], excluded: [] }
  const kept = []
  const fingerprints = []
  for (const chunk of chunks) {
    const body = (chunk.displayBody ?? '').trim()
    if (policy.exclude?.(chunk)) {
      dropped.excluded.push(chunk)
    } else if (body === '') {
      dropped.emptyBody.push(chunk)
    } else if (policy.dropAnchorOnly && isAnchorOnlyBody(body)) {
      dropped.anchorOnlyBody.push(chunk)
    } else if (policy.dropValueless && isValuelessBody(body)) {
      dropped.valueless.push(chunk)
    } else if (policy.dropRedirectStubs && isRedirectStub(body)) {
      dropped.redirectStub.push(chunk)
    } else if (config.measure(body) < config.minTokens) {
      dropped.tooSmallBody.push(chunk)
    } else {
      const fingerprint = `${chunk.label ?? ''}\0${chunk.embeddingBody.trim()}`
      if (policy.deduplicate && fingerprints.includes(fingerprint)) {
        dropped.duplicates.push(chunk)
      } else {
        fingerprints.push(fingerprint)
        kept.push(chunk)
      }
    }
  }
  return { outputFilter: kept, dropped }
}
