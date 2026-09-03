const HEADING = /^(\s*#{1,6}) (.+)$/
const SOURCE = /Source:\s*(\S+)/i

let duration = 0
let question = 0
export function resolveIds(chunks, q, sourceMap) {
  question++
  const start = performance.now()
  const resolvedChunks = []
  const noSourceFound = []
  for (const text of chunks) {
    const ids = []
    const lines = (text || '').split('\n')
    let i = 0
    const firstLine = text.split('\n')[0]
    firstLine.replace(' / ', ' > ')
    const headings = firstLine
      .split(' > ')
      .map(h => h.replace(/^#{1,6}\s+/, '').trim())
      .filter(Boolean)
    if (!headings.length) {
      ids.push(`/placeholder/source/${firstLine}`)
      console.warn(`No breadcrumb found for ${q.id}: ${text}`)
    } 
    // when result has no heading (old behavior)
    else if (text.split('\n')[1] !== '' && !/^#{1,6}\s+/.test(text.split('\n')[1])) {
      let finds = sourceMap.filter(s => s.breadcrumb === headings.join(' > ') || s.nonTransformedBreadcrumb === headings.join(' > '))
      if (!finds.length) {
        finds = sourceMap.filter(s => s.title === headings[headings.length-1])
      }
      if (finds.length === 1) {
        ids.push(finds[0].source)
      } else {
        ids.push(`/placeholder/source/${firstLine}`)
        noSourceFound.push(`${finds.length > 1 ? 'Multiple' : 'No'} sources found for ${q.id}: ${firstLine}`)
      }
    } else {
      // new behavior
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
          const findsByHeading = sourceMap.filter(s => s.title === heading && s.depth === depth)
          if (!findsByHeading.length) continue
          else if (findsByHeading.length === 1) {
            ids.push(findsByHeading[0].source)
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
          const fullBreadcrumb = [...headings, ...breadCrumb].join(' > ')
          const finds = sourceMap.filter(s => s.breadcrumb === fullBreadcrumb)
          if(finds.length) ids.push(finds[0].source)
        }
        i++
      }
    }

    if (!ids.length) throw Error('No IDs found')
    resolvedChunks.push({ ids, text })
  }
  if (noSourceFound.length) console.warn(`Added ${noSourceFound.length} placeholders sources for ${q.id}`)
  duration = duration + performance.now() - start
  if (question === 100) console.log(duration)
  return resolvedChunks
}
