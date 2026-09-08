const HEADING = /^(\s*#{1,6}) (.+)$/
const SOURCE = /Source:\s*(\S+)/i
const HEADINGPATH = /HeadingPath:\s*(.+)/i

const PLACEHOLDER = '/placeholder/source/'
const LLM_MODEL = process.env.EVAL_LLM_MODEL || 'claude-opus-4-5'

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

  const lines = sourceMap
    .map((c, i) => `${i + 1}. ${c.breadcrumb || c.title || c.source}  ::  ${c.source}`)
    .join('\n')
  const prompt =
    `You are matching a retrieved documentation chunk to its source URL.\n` +
    `Pick the single best-fitting entry from the candidates below. Reply with ONLY the number (1-${sourceMap.length}) or the word NONE if no candidate fits.\n\n` +
    `Chunk:\n"""\n${text.slice(0, 4000)}\n"""\n\n` +
    `Candidates:\n${lines}`

  try {
    const c = await anthropicClient()
    const resp = await c.messages.create({
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
    const ta = byTitle.get(s.title) || []; ta.push(s); byTitle.set(s.title, ta)
    const key = `${s.title}::${s.depth}`
    const tda = byTitleDepth.get(key) || []; tda.push(s); byTitleDepth.set(key, tda)
    const sa = bySource.get(s.source) || []; sa.push(s); bySource.set(s.source, sa)
  }
  return { byBreadcrumb, byNonTransformed, byTitle, byTitleDepth, bySource }
}

export async function resolveIds(results, q, sourceMap, smIndex = null, logger = console) {
  const idx = smIndex || buildSourceMapIndex(sourceMap)
  const { byBreadcrumb, byNonTransformed, byTitle, byTitleDepth, bySource } = idx
  const llmOn = isLlmFallbackEnabled()

  async function pushPlaceholderOrLlm(ids, text, placeholderId, warnMsg) {
    if (llmOn) {
      const picked = await llmResolvePlaceholder(text, sourceMap, logger)
      if (picked) { ids.push(picked); return }
    }
    ids.push(placeholderId)
    logger.warn(warnMsg)
  }

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
      await pushPlaceholderOrLlm(
        ids,
        text,
        `${PLACEHOLDER}${lines[0].replace(/headingPath:\s*/i, '')}`,
        `No breadcrumb found for ${q.id}: ${text}`
      )
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
        await pushPlaceholderOrLlm(
          ids,
          text,
          `${PLACEHOLDER}${firstLine}`,
          `${candidates.length > 1 ? 'Multiple' : 'No'} sources found for ${q.id}: ${firstLine}`
        )
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
          const firstHeadingDepht = HEADING.exec(firstHeading)[1].trim().length
          for (let j = i - 1; j >= 0; j--) {
            const entry = lines[j]
            const em = HEADING.exec(entry)
            if (!em) continue
            const entryDepth = em[1].trim().length
            if (entry === firstHeading && firstHeadingDepht === 1) continue
            if (entryDepth < currDepth) {
              breadCrumbInText.unshift(em[2])
              currDepth = entryDepth
            }
            if (entryDepth <= 1) break
          }
          const fullBreadcrumb = [...headings, ...breadCrumbInText].join(' > ')
          const found = byBreadcrumb.get(fullBreadcrumb)
          if (found) ids.push(found.source)
          else {
            const parent = sourceMap.find(m => m.source === ids[0])
            const start = sourceMap.indexOf(parent)
            let found = false
            for (let i = start+1; i < sourceMap.length; i++) {
              const current = sourceMap[i]
              if (current.depth < depth) continue
              if (current.depth < depth) break
              if (current.title === heading) {
                found = true
                ids.push(current.source)
                break
              }
            }
            if (!found) {
              await pushPlaceholderOrLlm(
                ids,
                text,
                `${PLACEHOLDER}${firstLine.replace(/headingPath:\s*/i, '')}`,
                `Added placeholder source for ${q.id} heading: ${heading}`
              )
            }
          }
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
