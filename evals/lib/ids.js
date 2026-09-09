const HEADING = /^\s*(#{1,6}) (.+)$/
const SOURCE = /Source:\s*(\S+)/i
const HEADINGPATH = /HeadingPath:\s*/i

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

// LLM fallback: when resolveIds would push a /placeholder/source/ id, ask the
// LLM to pick the closest entry from the full sourceMap. Returns a source
// string or null when the LLM abstains / errors.
async function llmResolvePlaceholder(text, sourceMap, logger = console) {
  if (!sourceMap.length) return null

  const candidateLines = sourceMap
    .map((c, i) => `${i + 1}. ${c.breadcrumb || c.title || c.source}  ::  ${c.source}`)
    .join('\n')
  const prompt =
    `You are matching a retrieved documentation chunk to its source URL.\n` +
    `Pick the single best-fitting entry from the candidates below. Reply with ONLY the number (1-${sourceMap.length}) or the word NONE if no candidate fits.\n\n` +
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
    if (!Number.isFinite(n) || n < 1 || n > sourceMap.length) return null
    return sourceMap[n - 1].source
  } catch (err) {
    logger.warn(`LLM fallback failed: ${err.message}`)
    return null
  }
}

export function buildSourceMapIndex(sourceMap) {
  const byBreadcrumb = new Map()
  const byNonTransformed = new Map()
  const byTitle = new Map()
  const byTitleDepth = new Map()
  const bySource = new Map()
  for (const s of sourceMap) {
    if (s.breadcrumb) byBreadcrumb.set(s.breadcrumb, s)
    if (s.nonTransformedBreadcrumb) byNonTransformed.set(s.nonTransformedBreadcrumb, s)
    const ta = byTitle.get(s.title) || []
    ta.push(s)
    byTitle.set(s.title, ta)
    const key = `${s.title}::${s.depth}`
    const tda = byTitleDepth.get(key) || []
    tda.push(s)
    byTitleDepth.set(key, tda)
    const sa = bySource.get(s.source) || []
    sa.push(s)
    bySource.set(s.source, sa)
  }
  return { byBreadcrumb, byNonTransformed, byTitle, byTitleDepth, bySource }
}

// Extract heading breadcrumb from a chunk. Prefers an explicit
// "HeadingPath: A > B > C" line; falls back to parsing the first line
// as a "> "-separated breadcrumb with markdown "#" prefixes stripped.
function parseHeadings(lines, firstLine) {
  const breadCrumbLine = lines.find(line => HEADINGPATH.test(line))
  if (breadCrumbLine) {
    return breadCrumbLine.replace(HEADINGPATH, '').split(' > ')
  }
  return firstLine
    .split(' > ')
    .map(h => h.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean)
}

// Lookup for chunks without an inline "Source:" line. Tries the full
// breadcrumb (transformed and non-transformed), then falls back to a
// unique byTitle match on the deepest heading.
// Returns { source, ambiguous } — ambiguous flags multi-title collisions
// so the caller can shape the placeholder warning.
function findByHeadings(headings, idx) {
  const { byBreadcrumb, byNonTransformed, byTitle } = idx
  const bc = headings.join(' > ')
  let found = byBreadcrumb.get(bc) || byNonTransformed.get(bc)
  const candidates = byTitle.get(headings[headings.length - 1]) || []
  if (!found && candidates.length === 1) found = candidates[0]
  return { source: found?.source ?? null, ambiguous: !found && candidates.length > 1 }
}

// Given a sub-heading at lines[i] with its (heading, depth), walk backward
// through prior lines picking up every strictly-shallower heading — those
// are its ancestors within the chunk. Prepends `headings` (the chunk's
// top-level breadcrumb) so the result is a fully-qualified path suitable
// for byBreadcrumb lookup.
function buildSubHeadingBreadcrumb(lines, i, heading, depth, firstHeading, firstHeadingDepth, headings) {
  const ancestors = [heading]
  let currDepth = depth
  for (let j = i - 1; j >= 0; j--) {
    const em = HEADING.exec(lines[j])
    if (!em) continue
    const entryDepth = em[1].length
    // firstHeading at depth 1 is already covered by `headings`; skip to avoid duplication.
    if (lines[j] === firstHeading && firstHeadingDepth === 1) continue
    if (entryDepth < currDepth) {
      ancestors.unshift(em[2])
      currDepth = entryDepth
    }
    if (entryDepth <= 1) break
  }
  return [...headings, ...ancestors].join(' > ')
}

// Fallback for ambiguous byTitleDepth matches when the breadcrumb misses:
// scan sourceMap forward from the parent source and pick the first entry
// with matching title and depth >= target. Order in sourceMap is the
// implicit document layout, so the first hit past the parent is the
// nearest sibling.
function findSubHeadingBySiblingScan(sourceMap, parentSource, heading, depth) {
  const start = sourceMap.findIndex(entry => entry.source === parentSource)
  if (start === -1) return null
  const match = sourceMap.slice(start + 1).find(c => c.depth >= depth && c.title === heading)
  return match?.source ?? null
}

// Walk the chunk line-by-line. Every "Source: <url>" pushes an id. Every
// heading AFTER the first source-bearing heading is treated as a sub-heading
// and resolved via byTitleDepth → breadcrumb → sibling scan → placeholder.
async function resolveWithSourceLines(text, lines, firstLine, headings, ctx) {
  const { q, sourceMap, idx, pushPlaceholderOrLlm } = ctx
  const { byBreadcrumb, byTitleDepth } = idx
  const ids = []
  let firstHeading
  let firstHeadingDepth

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue

    const sourceMatch = line.match(SOURCE)
    if (sourceMatch) {
      ids.push(sourceMatch[1])
      continue
    }

    const headingMatch = HEADING.exec(line)
    if (!headingMatch) continue

    const isSubHeading = ids.length > 0 && firstHeading
    if (!isSubHeading) {
      firstHeading = line
      firstHeadingDepth = headingMatch[1].length
      continue
    }

    const depth = headingMatch[1].length
    const heading = headingMatch[2]
    const sameTitleDepth = byTitleDepth.get(`${heading}::${depth}`) || []
    if (!sameTitleDepth.length) continue
    if (sameTitleDepth.length === 1) {
      ids.push(sameTitleDepth[0].source)
      continue
    }

    const fullBreadcrumb = buildSubHeadingBreadcrumb(
      lines, i, heading, depth, firstHeading, firstHeadingDepth, headings
    )
    const found = byBreadcrumb.get(fullBreadcrumb)
    if (found) {
      ids.push(found.source)
      continue
    }

    const sibling = findSubHeadingBySiblingScan(sourceMap, ids[0], heading, depth)
    if (sibling) {
      ids.push(sibling)
      continue
    }

    await pushPlaceholderOrLlm(
      ids,
      text,
      `${PLACEHOLDER}${firstLine.replace(HEADINGPATH, '')}`,
      `Added placeholder source for ${q.id} heading: ${heading}`
    )
  }

  return ids
}

export async function resolveIds(results, q, sourceMap, smIndex = null, logger = console) {
  const idx = smIndex || buildSourceMapIndex(sourceMap)
  const llmOn = isLlmFallbackEnabled()

  async function pushPlaceholderOrLlm(ids, text, placeholderId, warnMsg) {
    if (llmOn) {
      const picked = await llmResolvePlaceholder(text, sourceMap, logger)
      if (picked) { logger.warn(`Added source found by llm for ${q.id}`); ids.push(picked); return }
    }
    ids.push(placeholderId)
    logger.warn(warnMsg)
  }

  const ctx = { q, sourceMap, idx, pushPlaceholderOrLlm }
  const resolvedChunks = []

  for (const text of results) {
    const lines = text ? text.split('\n') : ['']
    const firstLine = lines[0]
    const headings = parseHeadings(lines, firstLine)
    let ids = []

    if (!headings.length) {
      await pushPlaceholderOrLlm(
        ids,
        text,
        `${PLACEHOLDER}${firstLine}`,
        `No breadcrumb found for ${q.id}: ${text}`
      )
    } else if (!/source: /i.test(text)) {
      // old behavior: no inline "Source:" lines — look up by breadcrumb/title
      const { source, ambiguous } = findByHeadings(headings, idx)
      if (source) {
        ids.push(source)
      } else {
        await pushPlaceholderOrLlm(
          ids,
          text,
          `${PLACEHOLDER}${firstLine}`,
          `${ambiguous ? 'Multiple' : 'No'} sources found for ${q.id}: ${firstLine}`
        )
      }
    } else {
      // new behavior: "Source:" lines under each heading
      ids = await resolveWithSourceLines(text, lines, firstLine, headings, ctx)
    }

    if (!ids.length) throw new Error('No IDs found')
    resolvedChunks.push({ ids, text })
  }
  return resolvedChunks
}
