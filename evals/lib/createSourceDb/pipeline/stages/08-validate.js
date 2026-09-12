function isMissing(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}

function label(chunk) {
  return chunk.heading || '(unknown)';
}

export function validate(chunks, config) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(chunks)) {
    throw new Error('[validate] chunks must be an array');
  }

  chunks.forEach((chunk, i) => {

    if (isMissing(chunk.breadcrumb)) {
      errors.push(`missing breadcrumb: heading=${JSON.stringify(chunk.heading)}`);
    }
    if (isMissing(chunk.heading)) {
      errors.push(`missing heading: breadcrumb=${JSON.stringify(chunk.breadcrumb)}`);
    }

    if (isMissing(chunk.source)) {
      errors.push(`missing source: source=${JSON.stringify(chunk.source)}`);
    } else if ((chunk.source.match(/^Source:\s/gm) || []).length > 1) {
      errors.push(`multiple sources: ${label(chunk)}`);
    }

    if (isMissing(chunk.body)) {
      errors.push(`missing body: body=${JSON.stringify(chunk.body)}`);
    } else {
      const bodyLength = chunk.body.length;

      if (bodyLength < 10) {
        warnings.push(`suspiciously short body (${bodyLength} chars): ${label(chunk)}`);
      }

      if (bodyLength > 2 * config.maxChunkSize) {
        warnings.push(
          `oversized body (${bodyLength} > ${2 * config.maxChunkSize}): ${label(chunk)}`
        );
      }
    }

    if (chunk.breadcrumb && typeof chunk.breadcrumb === 'string' && chunk.heading &&
        chunk.breadcrumb.endsWith(chunk.heading)) {
      warnings.push(`breadcrumb redundantly includes heading: ${label(chunk)}`);
    }
  });

  for (const w of warnings) {
    process.stderr.write(`[validate] ${w}\n`);
  }

  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`[validate] error: ${e}\n`);
    }
    throw new Error(`[validate] ${errors.length} chunk(s) failed validation — see stderr`);
  }

  return chunks;
}
