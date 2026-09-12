const MEANINGFUL_PATTERNS = [
  /```[\s\S]/,
  /\|.+\|/,
  /\*\*(Note|Warning|Caution|Important|Tip)\*\*/i,
  /\[.+\]\(https?:\/\//,
  /`[^`]+`/,
  /^\s*[$>]\s+\S/m,
  /^\s*[-*+]\s/m,
];

function hasMeaningfulContent(body) {
  return MEANINGFUL_PATTERNS.some((pattern) => pattern.test(body));
}

function getCategory(source) {
  if (!source) return '';
  const match = source.match(/\/docs\/([^/]+)/);
  return match ? match[1] : '';
}

// True when the body consists entirely of ######-slug anchor lines (no real prose).
function isAnchorOnlyBody(body) {
  let sawSlug = false;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    if (/^#{4,6}\s+\S/.test(t)) { sawSlug = true; continue; }
    return false;
  }
  return sawSlug;
}

// True when the body carries no retrievable information.
function isValuelessBody(b) {
  if (/```/.test(b)) return false;
  if (/(^|[^!])\[[^\]]*\]\([^)]*\)/.test(b)) return false;
  if (/^(will come soon|coming soon|tbd|to be (written|done|added))\.?$/i.test(b.trim())) return true;
  if (/^this documentation is not (complete|available) yet/i.test(b.trim())) return true;
  const stripped = b
    .replace(/!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '')
    .replace(/<\/?[A-Za-z][^>]*\/?>/g, '')
    .replace(/\{\.[a-z-]+\}/gi, '')
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/\bTODO\b/g, '')
    .replace(/[\s#>*_|()-]/g, '')
    .trim();
  return stripped.length === 0;
}

// True when the body is a single redirect link with no surrounding prose.
function isRedirectStub(b) {
  if (/```/.test(b)) return false;
  if (/^\s*[-*+]\s/m.test(b)) return false;
  if (/^\s*\|/m.test(b)) return false;
  const links = b.match(/\[[^\]]*\]\([^)]*\)/g);
  if (!links || links.length !== 1) return false;
  if (/^\[As in /i.test(links[0])) return false;
  const stripped = b
    .replace(/!?\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '')
    .replace(/[\s#>*_|.-]/g, '')
    .trim();
  return stripped === '';
}

export function filter(chunks, config) {
  const dropped = {
    releases: [],
    emptyBody: [],
    anchorOnlyBody: [],
    valueless: [],
    redirectStub: [],
    toSmallBody: [],
    duplicates: []
  }

  const kept = [];
  const keptIndices = new Set();

  for (let k = 0; k < chunks.length; k++) {
    const chunk = chunks[k];

    if (getCategory(chunk.source) === 'releases') {
      dropped.releases.push(chunk)
      continue
    };

    const body = (chunk.body ?? '').trim();
    if (body.length === 0) {
      dropped.emptyBody.push(chunk)
      continue
    };

    if (isAnchorOnlyBody(body)) {
      dropped.anchorOnlyBody.push(chunk)
      continue
    };

    if (isValuelessBody(body)) {
      dropped.valueless.push(chunk)
      continue
    };

    if (isRedirectStub(body)) {
      dropped.redirectStub.push(chunk)
      continue
    }

    if (body.length < config.minChunkSize && chunk.depth < 2 && !hasMeaningfulContent(body)) {
      dropped.toSmallBody.push(chunk)
      continue
    };

    kept.push(chunk);
    keptIndices.add(k);
  }

  // Body-hash dedup: same prose under multiple anchors.
  const seen = new Set();
  const outputFilter = kept.filter((c) => {
    const b = (c.body ?? '').trim();
    if (seen.has(b)) {
      dropped.duplicates.push(c)
      return false
    };
    seen.add(b);
    return true;
  });

  for (const key in dropped) {
    if (dropped[key].length) process.stderr.write(`[filter] dropped ${dropped[key].length} ${key} chunks\n`);
  }

  return { outputFilter, dropped }
}
