const HEADING = /^(\s*#{1,6}) (.+)$/
const SOURCE = /Source:\s*(\S+)/i

export function buildSourceMapIndex(sourceMap) {
  const byBreadcrumb = new Map()
  const byNonTransformed = new Map()
  const byTitle = new Map()
  const byTitleDepth = new Map()
  for (const s of sourceMap) {
    if (s.breadcrumb) byBreadcrumb.set(s.breadcrumb, s)
    if (s.nonTransformedBreadcrumb) byNonTransformed.set(s.nonTransformedBreadcrumb, s)
    const ta = byTitle.get(s.title) || []; ta.push(s); byTitle.set(s.title, ta)
    const key = `${s.title}::${s.depth}`
    const tda = byTitleDepth.get(key) || []; tda.push(s); byTitleDepth.set(key, tda)
  }
  return { byBreadcrumb, byNonTransformed, byTitle, byTitleDepth }
}

export function resolveIds(chunks, q, sourceMap, smIndex = null) {
  const idx = smIndex || buildSourceMapIndex(sourceMap)
  const { byBreadcrumb, byNonTransformed, byTitle, byTitleDepth } = idx
  const resolvedChunks = []
  const noSourceFound = []
  for (const text of chunks) {
    const ids = []
    const lines = text ? text.split('\n') : ['']
    let i = 0
    const firstLine = lines[0]
    const headings = firstLine
      .split(' > ')
      .map(h => h.replace(/^#{1,6}\s+/, '').trim())
      .filter(Boolean)
    if (!headings.length) {
      ids.push(`/placeholder/source/${firstLine}`)
      console.warn(`No breadcrumb found for ${q.id}: ${text}`)
    }
    // when result has no heading (old behavior)
    else if (lines[1] !== '' && !HEADING.test(lines[1])) {
      const bc = headings.join(' > ')
      let found = byBreadcrumb.get(bc) || byNonTransformed.get(bc)
      if (!found) {
        const candidates = byTitle.get(headings[headings.length - 1]) || []
        if (candidates.length === 1) found = candidates[0]
      }
      if (found) {
        ids.push(found.source)
      } else {
        const candidates = byTitle.get(headings[headings.length - 1]) || []
        ids.push(`/placeholder/source/${firstLine}`)
        noSourceFound.push(`${candidates.length > 1 ? 'Multiple' : 'No'} sources found for ${q.id}: ${firstLine}`)
      }
    } else {
      // new behavior
      for (const line of lines) {
        if (line.trim() === '') {
          i++
          continue
        }
        const m = lines[i + 2]?.match(SOURCE)
        if (m) {
          ids.push(m[1])
          i = i + 3
          continue
        }
        if (HEADING.test(line)) {
          const match = HEADING.exec(line)
          const depth = match[1].trim().length
          const heading = match[2]
          const tdKey = `${heading}::${depth}`
          const findsByHeading = byTitleDepth.get(tdKey) || []
          if (!findsByHeading.length) { i++; continue }
          if (findsByHeading.length === 1) {
            ids.push(findsByHeading[0].source)
            i++
            continue
          }

          const breadCrumb = [heading]
          let currDepth = depth
          for (let j = i - 1; j >= 0; j--) {
            const entry = lines[j]
            const em = HEADING.exec(entry)
            if (!em) continue
            const entryDepth = em[1].trim().length
            if (entryDepth < currDepth) {
              breadCrumb.unshift(em[2])
              currDepth = entryDepth
            }
            if (entryDepth <= 1) break
          }
          const fullBreadcrumb = [...headings, ...breadCrumb].join(' > ')
          const found = byBreadcrumb.get(fullBreadcrumb)
          if (found) ids.push(found.source)
        }
        i++
      }
    }

    if (!ids.length) throw Error('No IDs found')
    resolvedChunks.push({ ids, text })
  }
  if (noSourceFound.length) console.warn(`Added ${noSourceFound.length} placeholders sources for ${q.id}`)
  return resolvedChunks
}
