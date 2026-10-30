import { isMissing } from '../utils.js'

function label(chunk) {
  return chunk.heading || '(unknown)'
}

export function validate(chunks, config) {
  const errors = []
  const warnings = []

  if (!Array.isArray(chunks)) {
    throw new Error('[validate] chunks must be an array')
  }

  chunks.forEach((chunk) => {
    if (isMissing(chunk.breadcrumb)) {
      errors.push(`missing breadcrumb: heading=${JSON.stringify(chunk.heading)}`)
    }
    if (isMissing(chunk.heading)) {
      errors.push(`missing heading: breadcrumb=${JSON.stringify(chunk.breadcrumb)}`)
    }

    if (isMissing(chunk.source)) {
      errors.push(`missing source: source=${JSON.stringify(chunk.source)}`)
    } else if ((chunk.source.match(/^Source:\s/gm) || []).length > 1) {
      errors.push(`multiple sources: ${label(chunk)}`)
    }

    if (isMissing(chunk.displayBody)) {
      errors.push(`missing displayBody: displayBody=${JSON.stringify(chunk)}`)
    }

    if (isMissing(chunk.embeddingBody)) {
      errors.push(`missing embeddingBody: embeddingBody=${JSON.stringify(chunk)}`)
    } else {
      const bodyTokens = config.measure(chunk.embeddingBody)
      const maxTokens = config.maxTokens

      if (bodyTokens < config.minTokens) {
        warnings.push(`suspiciously short embedding body (${bodyTokens} tokens): ${label(chunk)}`)
      }

      if (maxTokens && bodyTokens > maxTokens) {
        errors.push(
          `oversized embedding body (${bodyTokens} > ${maxTokens} tokens): ${label(chunk)}`
        )
      }
    }

    if (
      chunk.breadcrumb &&
      typeof chunk.breadcrumb === 'string' &&
      chunk.heading &&
      chunk.breadcrumb.endsWith(chunk.heading)
    ) {
      warnings.push(`breadcrumb redundantly includes heading: ${label(chunk)}`)
    }
  })

  for (const w of warnings) {
    process.stderr.write(`[validate] ${w}\n`)
  }

  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`[validate] error: ${e}\n`)
    }
    throw new Error(`[validate] ${errors.length} chunk(s) failed validation — see stderr`)
  }

  return chunks
}
