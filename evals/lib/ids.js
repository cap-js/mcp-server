import cds from '@sap/cds'
import { CONTAINER_OPENER, CONTAINER_CLOSER, HTML_DIV_CLOSE, HTML_ANY_DIV_OPEN, COLS_DIV_OPEN, JAVA_NODE_DIV_OPEN } from './createSourceDb/pipeline/stages/04-parse-blocks.js'

const { SELECT } = cds.ql

const HEADING = /^\s*(#{1,6}) (.+)$/
const SOURCE = /Source:\s*(\S+)/i
const HEADINGPATH = /^HeadingPath:\s*/i
const LEGACYHEADINGPATH = /^[^>\n]+(?: > [^>\n]+)+$/
const FENCE_OPENER_RE = /^(\s*)(```+|~~~+)/
const FENCE_CLOSER_RE = /^(\s*)(```+|~~~+)\s*$/

function isNotInsideFence(lines, lastHeadingIndex, index) {
  let fenceChar = null, fenceLen = 0
  for (let i = lastHeadingIndex; i < index; i++) {
    const m = FENCE_OPENER_RE.exec(lines[i])
    if (!m) continue
    if (fenceChar === null) { fenceChar = m[2][0]; fenceLen = m[2].length }
    else if (FENCE_CLOSER_RE.test(lines[i]) && m[2][0] === fenceChar && m[2].length >= fenceLen) { fenceChar = null; fenceLen = 0 }
  }
  return fenceChar === null
}

function isNotInsideContainer(lines, lastHeadingIndex, index) {
  for (let i = index - 1; i >= lastHeadingIndex; i--) {
    if (CONTAINER_OPENER.test(lines[i])) return false
    if (CONTAINER_CLOSER.test(lines[i])) return true
  }
  return true
}

function isNotInsideJavaNodeDivOrColDiv(lines, lastHeadingIndex, index) {
  let closesSeen = 0
  for (let i = index - 1; i >= lastHeadingIndex; i--) {
    const line = lines[i]
    if (HTML_DIV_CLOSE.test(line)) { closesSeen++; continue }
    if (HTML_ANY_DIV_OPEN.test(line)) {
      if (closesSeen > 0) { closesSeen--; continue }
      if (JAVA_NODE_DIV_OPEN.test(line) || COLS_DIV_OPEN.test(line)) return false
    }
  }
  return true
}

// Split text into sections by markdown heading, skipping headings inside fences/containers/divs.
// Returns [{ headingText, headingDepth, headingBody }]
function splitByHeadings(text) {
  const lines = text.split('\n')
  const sections = []
  let currentHeading = null
  let currentDepth = 0
  const bodyLines = []
  let lastHeadingIndex = 0

  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i])
    if (m &&
      isNotInsideContainer(lines, lastHeadingIndex, i) &&
      isNotInsideJavaNodeDivOrColDiv(lines, lastHeadingIndex, i) &&
      isNotInsideFence(lines, lastHeadingIndex, i)
    ) {
      if (currentHeading !== null) {
        sections.push({ headingText: currentHeading, headingDepth: currentDepth, headingBody: bodyLines.join('\n') })
        bodyLines.length = 0
      }
      currentHeading = m[2]
      currentDepth = m[1].length
      lastHeadingIndex = i
    } else {
      bodyLines.push(lines[i])
    }
  }
  if (currentHeading !== null) {
    sections.push({ headingText: currentHeading, headingDepth: currentDepth, headingBody: bodyLines.join('\n') })
  }

  return sections
}

// Find source by title and body content in sourceDb.
// Returns { source: string|null, ambiguous: boolean }
async function findSource(headingText, headingBody, sourceDb) {
  try {
    let byTitle = []
    // Inline Source: line in body takes priority
    const inlineSource = headingBody?.match?.(SOURCE)
    if (inlineSource) return { source: inlineSource[1], ambiguous: false }
    const title = headingText.trim()
  
    if (title) {
      // 4.1: exact title match
      byTitle = await sourceDb.run(SELECT.from('SourceDocs').where`title like ${'%' + title + '%'}`)
      if (byTitle.length === 1) return { source: byTitle[0].source, ambiguous: false }
    }
  
    // 4.2: subselect on title, like search with headingBody slice
    const slice = (headingBody || '').trim().slice(0, 50).replace(/[%_'\\]/g, ' ')?.trim()
    let query
    if (slice) {
      if (byTitle.length > 1) {
        query =  SELECT.from('SourceDocs').where`title in ${byTitle.map(r=>r.title)} and chunk like ${'%' + slice + '%'}`
      } else {
        query =  SELECT.from('SourceDocs').where`chunk like ${'%' + slice + '%'}`
      }
      const like = await sourceDb.run(query)
      if (like.length > 0) return { source: like[0].source, ambiguous: false }
    }
  
    // use cosine similarity as a fallback for legacy chunks
    let inner = SELECT.from('SourceDocs')
      .columns`source, cosine_similarity(emb, vector_embedding(${title + ' ' + slice}, 'QUERY', '')) as score`
    if (byTitle.length > 1) inner = inner.where`title in ${byTitle.map(r=>r.title)}`
    const similar = await sourceDb.run(
      SELECT.from(inner).orderBy('score desc').limit(1)
    )
    if (similar.length > 0) return { source: similar[0].source, ambiguous: false }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(e)
  }
  return { source: null, ambiguous: true }
}

export async function resolveIds(results, q, sourceDb) {
  const resolvedChunks = []

  for (const text of results) {
    const ids = []
    const sections = []
    const meta = {}
    let body = text || ''

    // Step 2: if text includes Source:, extract it and headingPath as meta, then slice to after first heading
    if (/source: /i.test(body)) {
      const sourceMatch = body.match(SOURCE)
      if (!sourceMatch) throw new Error('No IDs found')
      ids.push(sourceMatch[1])
      meta.source = sourceMatch[1]

      const lines = body.split('\n')
      const hpLine = lines.find(l => HEADINGPATH.test(l))
      if (hpLine) meta.headingPath = hpLine.replace(HEADINGPATH, '').trim()

      const firstHeadingIdx = lines.findIndex(l => HEADING.test(l))
      body = firstHeadingIdx >= 0 ? lines.slice(firstHeadingIdx + 1).join('\n') : ''
    } else {
      const lines = body.split('\n')
      const hpLine = lines.find(l => LEGACYHEADINGPATH.test(l))
      if (hpLine) {
        meta.headingPath = hpLine.trim()
        body = lines.slice(2).join('\n')
        const headingDepth = hpLine.split(' > ').length
        const title = hpLine.split(' > ').pop().trim()
        sections.push({ headingText: title, headingDepth, headingBody: body })
      } else {
        const title = lines[0].trim()
        body = lines.slice(1).join('\n')
        const headingDepth = 1
        sections.push({ headingText: title, headingDepth, headingBody: body })
      }
    }

    // Step 3: split body by headings
    sections.push(...splitByHeadings(body))

    // Step 4: for every headingBody, find source in sourceDb
    for (const { headingText, headingBody } of sections) {
      const { source } = await findSource(headingText, headingBody, sourceDb, meta)
      if (source) {
        ids.push(source)
      }
    }

    if (!ids.length) throw new Error(`No IDs found for ${q.id}`)
    resolvedChunks.push({ ids, text, ...meta })
  }

  return resolvedChunks
}
