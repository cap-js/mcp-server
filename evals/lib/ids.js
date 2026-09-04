const HEADING = /^(\s*#{1,6}) (.+)$/
const SOURCE = /Source:\s*(\S+)/i
const HEADINGPATH = /HeadingPath:\s*(.+)/i

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

export function resolveIds(results, q, sourceMap, smIndex = null) {
  const idx = smIndex || buildSourceMapIndex(sourceMap)
  const { byBreadcrumb, byNonTransformed, byTitle, byTitleDepth } = idx
  const resolvedChunks = []
  for (const text of results) {
    const ids = []
    const lines = text ? text.split('\n') : ['']
    let i = 0
    const firstLine = lines[0]

    let headings    
    const breadCrumbLine = text.split('\n').find(line => HEADINGPATH.test(line))
    if (breadCrumbLine) {
      headings = breadCrumbLine.replace(/headingPath:\s*/i, '').split(' > ')
    } else {
      headings = lines[0]
        .split(' > ')
        .map(h => h.replace(/^#{1,6}\s+/, '').trim())
        .filter(Boolean)
    }
    
    if (!headings.length) {
      ids.push(`/placeholder/source/${lines[0].replace(/headingPath:\s*/i, '')}`)
      console.warn(`No breadcrumb found for ${q.id}: ${text}`)
    }
    // when result has no source (old behavior)
    else if (!text.toLowerCase().includes('source: ')) {
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
        console.warn(`${candidates.length > 1 ? 'Multiple' : 'No'} sources found for ${q.id}: ${firstLine}`)
      }
    } else {
      // new behavior: source under heading
      let firstHeading
      for (const line of lines) {
        if (line.trim() === '') {
          i++
          continue
        }
        const m = lines[i]?.match(SOURCE)
        if (m) {
          ids.push(m[1])
          i++
          continue
        }

        const isHeading = HEADING.test(line)
        // first heading already has source either in meta or below it
        if (ids.length > 0 && firstHeading && isHeading) {
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

          // calc breadcrumb for headings w/o source
          const breadCrumbInText = [heading]
          let currDepth = depth
          for (let j = i - 1; j >= 0; j--) {
            const entry = lines[j]
            if (entry === firstHeading) continue
            const em = HEADING.exec(entry)
            if (!em) continue
            const entryDepth = em[1].trim().length
            if (entryDepth < currDepth) {
              breadCrumbInText.unshift(em[2])
              currDepth = entryDepth
            }
            if (entryDepth <= 1) break
          }
          const fullBreadcrumb = [...headings, ...breadCrumbInText].join(' > ')
          const found = byBreadcrumb.get(fullBreadcrumb)
          if (found) ids.push(found.source)
          else console.warn(`Added placeholder source for ${q.id} heading: ${heading}`)
        } else if(isHeading) {
          firstHeading = line
        }
        i++
      }
    }

    if (!ids.length) throw Error('No IDs found')
    resolvedChunks.push({ ids, text })
  }
  return resolvedChunks
}
