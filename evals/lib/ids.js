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
// LLM to pick the closest entry from the full sourceDb. Returns a source
// string or null when the LLM abstains / errors.
async function llmResolvePlaceholder(text, sourceDb, logger = console) {
  if (!sourceDb.length) return null

  const candidateLines = sourceDb
    .map((c, i) => `${i + 1}. ${c.breadcrumb || c.title || c.source}  ::  ${c.source}`)
    .join('\n')
  const prompt =
    `You are matching a retrieved documentation chunk to its source URL.\n` +
    `Pick the single best-fitting entry from the candidates below. Reply with ONLY the number (1-${sourceDb.length}) or the word NONE if no candidate fits.\n\n` +
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
    if (!Number.isFinite(n) || n < 1 || n > sourceDb.length) return null
    return sourceDb[n - 1].source
  } catch (err) {
    logger.warn(`LLM fallback failed: ${err.message}`)
    return null
  }
}

// Walk the chunk line-by-line. Every "Source: <url>" pushes an id. Every
// heading AFTER the first source-bearing heading is treated as a sub-heading
// and resolved via byTitleDepth → breadcrumb → sibling scan → placeholder.
async function resolveWithSourceLines(text, lines, firstLine, headings, ctx) {
  const { q, sourceDb, pushPlaceholderOrLlm } = ctx
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

    const sibling = findSubHeadingBySiblingScan(sourceDb, ids[0], heading, depth)
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

export async function resolveIds(results, q, sourceDb, logger = console, binDir) {
  const llmOn = isLlmFallbackEnabled()

  async function pushPlaceholderOrLlm(ids, text, placeholderId, warnMsg) {
    if (llmOn) {
      const picked = await llmResolvePlaceholder(text, sourceDb, logger)
      if (picked) { logger.warn(`Added source found by llm for ${q.id}`); ids.push(picked); return }
    }
    ids.push(placeholderId)
    logger.warn(warnMsg)
  }

  const ctx = { q, sourceDb, pushPlaceholderOrLlm }
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
      const { source, ambiguous } = findByHeadings(headings)
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
