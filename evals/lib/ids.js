import cds from '@sap/cds'
import { CONTAINER_OPENER, CONTAINER_CLOSER, HTML_DIV_CLOSE, HTML_ANY_DIV_OPEN, COLS_DIV_OPEN, JAVA_NODE_DIV_OPEN } from './createSourceDb/pipeline/stages/04-parse-blocks.js'

const { SELECT } = cds.ql

const HEADING = /^\s*(#{1,6}) (.+)$/
const SOURCE = /Source:\s*(\S+)/i
const HEADINGPATH = /^HeadingPath:\s*/i

const PLACEHOLDER = '/placeholder/source/'
const LLM_MODEL = process.env.EVAL_LLM_MODEL || 'claude-sonnet-latest'
const LLM_MAX_CHUNK_CHARS = 4000

let _anthropicClient
async function anthropicClient() {
  if (_anthropicClient) return _anthropicClient
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  _anthropicClient = new Anthropic()
  return _anthropicClient
}

export function isLlmFallbackEnabled() {
  return process.env.EVAL_LLM_FALLBACK === 'true' && !!process.env.ANTHROPIC_API_KEY
}

async function getCandidates(sourceDb) {
  if (sourceDb?.run) {
    const rows = await sourceDb.run(SELECT.from('SourceDocs').columns('source', 'headingPath', 'title'))
    return rows.slice(0, 500)
  }
  return []
}

async function llmResolvePlaceholder(text, sourceDb, logger = console) {
  const candidates = await getCandidates(sourceDb)
  if (!candidates.length) return null

  const candidateLines = candidates
    .map((c, i) => `${i + 1}. ${c.breadcrumb || c.headingPath || c.title || c.source}  ::  ${c.source}`)
    .join('\n')
  const prompt =
    `You are matching a retrieved documentation chunk to its source URL.\n` +
    `Pick the single best-fitting entry from the candidates below. Reply with ONLY the number (1-${candidates.length}) or the word NONE if no candidate fits.\n\n` +
    `Chunk:\n"""\n${text.slice(0, LLM_MAX_CHUNK_CHARS)}\n"""\n\n` +
    `Candidates:\n${candidateLines}`

  try {
    const client = await anthropicClient()
    const resp = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: prompt }]
    })
    const out = resp.content?.[0]?.text?.trim() || ''
    if (/^NONE/i.test(out)) return null
    const n = parseInt(out.match(/\d+/)?.[0] || '', 10)
    if (!Number.isFinite(n) || n < 1 || n > candidates.length) return null
    return candidates[n - 1].source
  } catch (err) {
    logger.warn(`LLM fallback failed: ${err.message}`)
    return null
  }
}

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

  // Legacy chunk format: "A > B > Title\ntags\nbody..."
  if (sections.length === 0 && lines.length > 0 && !HEADING.test(lines[0]) && lines[0].includes(' > ')) {
    const title = lines[0].split(' > ').pop().trim()
    const headingBody = lines.slice(2).join('\n')
    sections.push({ headingText: title, headingDepth: lines[0].split(' > ').length, headingBody })
  }

  return sections
}

// Find source by title and body content in sourceDb.
// Returns { source: string|null, ambiguous: boolean }
async function findSource(headingText, headingBody, sourceDb) {
  if (!headingText) return { source: null, ambiguous: false }

  // Inline Source: line in body takes priority
  const inlineSource = headingBody?.match?.(SOURCE)
  if (inlineSource) return { source: inlineSource[1], ambiguous: false }

  const title = headingText.trim()

  // 4.1: exact title match
  const resp = await sourceDb.run(SELECT.from('SourceDocs'))
  const byTitle = await sourceDb.run(SELECT.from('SourceDocs').where`title like ${title}`)
  if (byTitle.length === 1) return { source: byTitle[0].source, ambiguous: false }

  // 4.2: subselect on title, fuzzy search with headingBody slice
  const slice = (headingBody || '').trim().slice(0, 50).replace(/[%_'\\]/g, ' ')
  let query
  if (slice.trim() && byTitle.length === 1) {
    query =  SELECT.from('SourceDocs').where`title = ${title} and chunk like ${'%' + slice + '%'}`
  } else {
    query =  SELECT.from('SourceDocs').where`chunk like ${'%' + slice + '%'}`
  }
  const fuzzy = await sourceDb.run(query)
  if (fuzzy.length > 0) return { source: fuzzy[0].source, ambiguous: false }

  // use cose similarity as a fallback for legacy chunks
  

  return { source: null, ambiguous: true }
}

// Find source by breadcrumb/headingPath in sourceDb.
async function findSourceByBreadcrumb(breadcrumb, sourceDb) {
  if (!breadcrumb) return null

  if (sourceDb && typeof sourceDb.run === 'function') {
    const results = await sourceDb.run(SELECT.from('SourceDocs').where`headingPath = ${breadcrumb}`)
    if (results.length === 1) return results[0].source
    return null
  }

  return null
}

export async function resolveIds(results, q, sourceDb, _smIndex, logger = console) {
  // Backward compat: some callers pass logger as 4th arg (no smIndex)
  if (_smIndex && typeof _smIndex.warn === 'function') logger = _smIndex

  const llmOn = isLlmFallbackEnabled()
  const resolvedChunks = []

  for (const text of results) {
    const ids = []
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
    }

    // Step 3: split body by headings
    const sections = splitByHeadings(body)

    // Step 4: for every headingBody, find source in sourceDb
    for (const { headingText, headingBody } of sections) {
      const { source } = await findSource(headingText, headingBody, sourceDb)
      if (source) {
        ids.push(source)
      } else if (llmOn) {
        // 4.3: LLM fallback
        const picked = await llmResolvePlaceholder(headingBody || text, sourceDb, logger)
        if (picked) { logger.warn(`Added source found by llm for ${q.id}`); ids.push(picked) }
      }
    }

    // Fallback: no ids yet — try first line as title then breadcrumb
    if (!ids.length) {
      const firstLine = (text || '').split('\n').find(l => l.trim()) || ''
      const title = firstLine.replace(HEADINGPATH, '').trim()
      const { source, ambiguous } = await findSource(title, text, sourceDb)
      if (source) {
        ids.push(source)
      } else {
        const bySrc = await findSourceByBreadcrumb(title, sourceDb)
        if (bySrc) {
          ids.push(bySrc)
        } else {
          if (llmOn) {
            const picked = await llmResolvePlaceholder(text, sourceDb, logger)
            if (picked) { logger.warn(`Added source found by llm for ${q.id}`); ids.push(picked) }
          }
          if (!ids.length) {
            ids.push(`${PLACEHOLDER}${firstLine}`)
            logger.warn(ambiguous
              ? `Multiple sources found for ${q.id}: ${firstLine}`
              : `No breadcrumb found for ${q.id}: ${text}`)
          }
        }
      }
    }

    if (!ids.length) throw new Error('No IDs found')
    resolvedChunks.push({ ids, text, ...meta })
  }

  return resolvedChunks
}
