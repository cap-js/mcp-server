const HEADING = /^#{1,6}\s+(.*\S)\s*$/
const SOURCE = /Source:\s*(\S+)/i

function getSourceByBreadCrump(headings, finds, sourceMap) {
  let candidates = finds
  for (const cand of candidates) {
    const idx = sourceMap.indexOf(cand)
    const path = [cand.title]
    let currDepth = cand.depth
    for (let i = idx - 1; i >= 0; i--) {
      const entry = sourceMap[i]
      if (entry.depth < currDepth) {
        path.unshift(entry.title)
        currDepth = entry.depth
      }
      if (entry.depth <= 1) break
    }
    const breadCrumb = path.join(' > ')
    if (breadCrumb === headings.join(' > ')) return cand.source
  }
  throw Error('No source found')
}

let duration = 0
let question = 0
export function resolveIds(chunks, sourceMap) {
  question++
  const start = performance.now()
  const resolvedChunks = []
  for (const text of chunks) {
    const ids = []
    const lines = (text || '').split('\n')
    let i = 0
    const headings = text.split('\n')[0]
      .split(' > ')
      .map(h => h.replace(/^#{1,6}\s+/, '').trim())
      .filter(Boolean)
    if (!headings.length) throw Error('No breadcrumb')

    for (const line of lines) {
      if(line.trim() === '') {
        i++
        continue
      }
      const m = lines[i+2]?.match(SOURCE)
      if (m) {
        ids.push(m[1])
        i = i + 3
        continue
      }
      if (/^#{1,6}\s+/.test(line)) {
        const match = /^(\s*#{1,6}) (.+)$/.exec(line)
        const depth = match[1].length
        const heading = line.replace(/^#{1,6}\s+/, '')
        const finds = sourceMap.filter(s => s.title === heading && s.depth === depth)
        if (!finds.length) continue
        else if (finds.length === 1) {
          ids.push(finds[0].source)
          continue
        }

        const breadCrumb = []
        breadCrumb.push(heading)
        const idx = lines.indexOf(line)
        let currDepth = depth
        for (let i = idx - 1; i >= 0; i--) {
          const entry = lines[i]
          const match = /^(\s*#{1,6}) (.+)$/.exec(entry)
          if (!match) continue
          const entryDepth = match[1].length
          if (entryDepth < currDepth) {
            breadCrumb.unshift(entry.replace(/^#{1,6}\s+/, ''))
            currDepth = entryDepth
          }
          if (entryDepth <= 1) break
        }
        const id = getSourceByBreadCrump([...headings, ...breadCrumb], finds, sourceMap)
        if(id) ids.push(id)
      }
      i++
    }
    if (!ids.length) throw Error('No IDs found')
    resolvedChunks.push({ ids, text })
  }
  duration = duration + performance.now() - start
  if (question === 100) console.log(duration)
  return resolvedChunks
}
