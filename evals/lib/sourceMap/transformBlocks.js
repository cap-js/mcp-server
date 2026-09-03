const HTML_STUB = /^<[A-Za-z][^>]*\/>\s*$|^<[a-z][a-z0-9]*(?:\s[^>]*)?>?\s*$|^<\/[a-z]+>\s*$|^<([a-z][a-z0-9]*)(?:\s[^>]*)?>[\s]*<\/\1>\s*$/;

function isHtmlStub(line) {
  return HTML_STUB.test(line.trim());
}

// 'foo\r\nbar\rend' → 'foo\nbar\nend'
function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// 'a\n\n\n\nb' → 'a\n\nb'
function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n');
}

// drops standalone HTML stub lines — matched cases:
//   self-closing:  '<br/>'  '<img src="x"/>'
//   bare open:     '<div>'  '<span class="x">'  '<p'  (unclosed >)
//   bare close:    '</div>'  '</p>'
//   empty paired:  '<p></p>'  '<div class="x"></div>'
function removeHtmlStubLines(text) {
  return text
    .split('\n')
    .filter((line) => !isHtmlStub(line))
    .join('\n');
}

// 'text {.class}' → 'text'   '<br/> {lang=js}' → '<br/>'  (any trailing {...} block)
function stripTrailingAttrBlock(text) {
  return text.split('\n').map(line => line.replace(/\s*\{[^}\n]*\}\s*$/, '')).join('\n');
}

// '<iframe src="url">desc</iframe>' → 'video (url): desc'   no src → desc only
function convertMediaEmbeds(text) {
  return text.replace(/<(iframe|video)\b([^>]*?)>([\s\S]*?)<\/\1>/gi, (m, _tag, attrs, inner) => {
    const sm = attrs.match(SRC_ATTR);
    const url = sm ? (sm[1] || sm[2]) : '';
    const desc = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!url) return desc || '';
    return desc ? `video (${url}): ${desc}` : `video (${url})`;
  });
}

function normalizeShared(text) {
  let t = normalizeLineEndings(text);
  t = collapseBlankLines(t);
  t = stripInlineHtml(t);
  t = convertMediaEmbeds(t);
  t = stripTrailingAttrBlock(t);
  t = removeHtmlStubLines(t);
  return t.trim();
}

// '```js\r\ncode\r\n```' → '```js\ncode\n```'
function normalizeFence(text) {
  return normalizeLineEndings(text).trim();
}

// 'hello  world  `a  b`' → 'hello world `a  b`'  (spaces outside backticks only)
function collapseSpacesOutsideBackticks(line) {
  if (!line.includes('`') && !line.includes('  ')) return line;
  const parts = line.split('`');
  return parts
    .map((part, idx) => (idx % 2 === 0 ? part.replace(/ {2,}/g, ' ') : part))
    .join('`');
}

// 'a\n\n\n\nb' → 'a\n\nb'  (no HTML stripping — tables/admonitions safe)
function normalizeStructural(text) {
  let t = normalizeLineEndings(text);
  t = collapseBlankLines(t);
  return t.trim();
}

// '[label](url)' → 'label (url)'   bare-URL label → just url   empty label → just url
function flattenLinks(text) {
  if (!text.includes('](')) return text;
  return text.replace(/(\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]\()([^)]*)(\))/g, (m, pre, target) => {
    const url = target.trim();
    const label = pre.slice(1, -2).trim(); // strip '[' prefix and '](' suffix
    return (label === '' || label === url) ? url : `${label} (${url})`;
  });
}

// '[x](../guide.md)' with source '/docs/java/ref.md' → '[x](/docs/java/guide)'
function resolveRelativeLinks(text, source) {
  if (!source) return text;
  if (!text.includes('](') && !text.includes(']: ') && !text.includes('<a ')) return text;
  const rawSource = source.replace(/^>\s*Source:\s*/, '').trim();
  const hashPath = rawSource.replace(/#.*$/, '');
  const dir = hashPath.replace(/\/[^/]*$/, '');
  const ROOT = '/docs';
  const resolve = (target) => {
    if (target.startsWith('[')) throw new Error(`resolveRelativeLinks: bracket in URL — likely a malformed reference-style label used as a URL: ${JSON.stringify(target)} (source: ${rawSource})`);
    if (/^(https?:|mailto:|tel:|\/\/|#\/)/i.test(target)) return target;
    if (target.startsWith('#')) return hashPath + target;
    if (target.startsWith('/')) return target;
    const hashIdx = target.indexOf('#');
    const rel = hashIdx === -1 ? target : target.slice(0, hashIdx);
    const anchor = hashIdx === -1 ? '' : target.slice(hashIdx);
    const base = dir.split('/');
    for (const seg of rel.replace(/\.md$/, '').split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        // never pop above ROOT
        if (base.join('/') !== ROOT) base.pop();
      } else {
        base.push(seg);
      }
    }
    return base.join('/') + anchor;
  };
  return text
    .replace(/(\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]\()([^)]*)(\))/g, (m, pre, target, post) => pre + resolve(target.trim()) + post)
    .replace(/^(\s*\[[^\]]+\]:\s+)(\S+)/gm, (m, pre, target) => pre + resolve(target.trim()))
    .replace(/(<a\s[^>]*href=)(["'])([^"']*)(\2)/gi, (m, pre, q, target, q2) => pre + q + resolve(target.trim()) + q2);
}

const BOILERPLATE_ALT = /is explained in the accompanying text|^(this |the )?(graphic|image|figure|diagram)\b[^.]{0,40}(is explained|shows|illustrates)\b/i;
const TITLE_IN_URL = /^\S+\s+(?:'([^']*)'|"([^"]*)")\s*$/;

function isFilenameAlt(alt) {
  const t = alt.trim();
  if (!t) return false;
  if (/^[A-Za-z0-9._-]+\.(?:drawio|svg|png|jpg|jpeg|gif|webp)$/i.test(t)) return true;
  return false;
}

// '![diagram.svg](img.svg)' → ''   '![Overview](img.svg)' → 'Overview'
function stripImageMarkup(text) {
  return text
    // Drop HTML image-only anchors: <a ...><img .../></a> — badge links, no prose value.
    .replace(/<a\b[^>]*>\s*<img\b[^>]*\/?>\s*<\/a>/gi, '')
    // Drop bare HTML img tags: <img .../> or <img ...>
    .replace(/<img\b[^>]*\/?>/gi, '')
    // Pre-pass: image-in-link [![alt](img)](url) → [alt](url).
    // The alt is the link label — never drop it regardless of filename appearance.
    .replace(/\[!\[([^\]]*)\]\([^)]*\)[ \t]*(?:\{[^}\n]*\})?\]\(([^)]*)\)/g, (m, alt, url) => {
      const label = alt.trim();
      return label ? `[${label}](${url})` : '';
    })
    .replace(/!\[([^\]]*)\]\(([^)]*)\)[ \t]*(\{[^}\n]*\})?/g, (m, alt, urlAndTitle) => {
      const tm = urlAndTitle.match(TITLE_IN_URL);
      const title = tm ? (tm[1] || tm[2] || '') : '';
      if (title && title.trim().length > alt.trim().length) return title.trim();
      return (isFilenameAlt(alt) || BOILERPLATE_ALT.test(alt.trim())) ? '' : alt.trim();
    })
    .replace(/\[\s*\]\([^)]*\)/g, '')
    .replace(/[ \t]+$/, '');
}

// masks `a  b` before calling fn, restores after — lets fn skip inline code spans
function withMaskedInlineCode(line, fn) {
  if (!line.includes('`')) return fn(line);
  const spans = [];
  const masked = line.replace(/`[^`\n]+?`/g, (m) => {
    spans.push(m);
    return `\x00${spans.length - 1}\x00`;
  });
  return fn(masked).replace(/\x00(\d+)\x00/g, (_, i) => spans[Number(i)]);
}

// '# T ![x](y)' → '# T '   remaining {} → ''   (entity decoding is a separate pipeline step)
function stripHeadingExtras(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // inline images → ''
    .replace(/\{\}/g, '');                 // remaining {}
}

// '# Title {.class}' → '# Title'   '<UnderConstruction/>' → line dropped
function stripClassMarkers(text) {
  return text.split('\n').map((line) => {
    if (line.trim() === '') return line;
    const isHeading = /^#{1,6}\s/.test(line);
    const stripped = withMaskedInlineCode(line, (s) => {
      let r = s
        .replace(/\{\s*[.#][^}\n]*\}/g, '')       // '{.className}' → ''   '{#className}' → ''
        .replace(/<UnderConstruction\s*\/?>/gi, '') // '<UnderConstruction/>' → ''
        .replace(/(^|\s)\{\}(?=\s|$)/g, '$1');     // 'foo {} bar' → 'foo  bar'  (orphan {})
      if (isHeading) r = stripHeadingExtras(r);
      return r.replace(/\s+$/, ''); // trim trailing whitespace
    });
    // drop lines that had content but became empty after stripping
    return stripped.trim() === '' ? null : stripped;
  }).filter((line) => line !== null).join('\n');
}

const NAMED_ENTITIES = {
  nbsp: ' ', emsp: '> ', ensp: ' ',
  lt: '<', gt: '>', quot: '"', amp: '&',
  ndash: '–', mdash: '—', rarr: '→', check: '✓',
};

// 'a &amp; b &rarr; c &#39;d&#39;' → 'a & b → c \'d\''
function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      const c = NAMED_ENTITIES[name.toLowerCase()];
      return c !== undefined ? c : m;
    });
}

const VOID_TAGS = new Set(['br', 'hr', 'wbr', 'div', 'span', 'p', 'img', 'details', 'summary']);
const WRAPPER_TAGS = new Set(['table', 'thead', 'tbody', 'tr', 'td', 'th', 'ul', 'ol', 'li']);
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const STRIP_TAGS = /<[^>]*>/g;

// Tags whose semantic label should survive as plain text for embedding retrieval.
// <Since version="v10" .../> → "since v10"   <Beta/> → "Beta"
const JSX_BADGE_LABELS = {
  beta: '(Beta)', alpha: '(Alpha)', gamma: '(Gamma)', 
  concept: '(Concept)', internal: '(SAP specific)',
  x: 'Yes', na: 'N/A', d: 'Deprecated', y: 'Yes', o: 'no'
};

function resolveSelfClosingJsx(tag, attrs) {
  const key = tag.toLowerCase();
  if (key === 'since') {
    const ver = attrs.match(/\bversion=["']([^"']+)["']/i);
    const pkg = attrs.match(/\bpackage=["']([^"']+)["']/i);
    if (!ver) return '';
    return pkg ? `(Since ${pkg[1]} ${ver[1]})` : `(Since ${ver[1]})`;
  }
  return JSX_BADGE_LABELS[key] ?? '';
}

// Paired PascalCase tags: tag name (lowercase) → (inner, attrs) => string
// Unrecognised tags fall back to inner.trim() — content kept, wrapper dropped.
const JSX_PAIRED_TRANSFORMS = new Map([
  ['config', (inner, attrs) => {
    const runtime = /\bjava\b/i.test(attrs) ? 'Java' : /\bnode\b/i.test(attrs) ? 'Node.js' : null;
    return runtime ? `${runtime}: ${inner.trim()}` : inner.trim();
  }],
  ['tip',     (inner) => `Tip: ${inner.trim()}`],
  ['warning', (inner) => `Warning: ${inner.trim()}`],
  ['danger',  (inner) => `Danger: ${inner.trim()}`],
]);

// '<Badge/>' → ''   '<Beta/>' → '(Beta)'   '<Since version="v10"/>' → '(Since v10)'
// '<Tip>note</Tip>' → 'Tip: note'   '<Config java>key</Config>' → 'Java: key'
function stripJsxComponents(text) {
  let t = text;
  for (let k = 0; k < 8; k++) {
    const before = t;
    // self-closing uppercase component tags: replace with label or drop
    t = t.replace(/<([A-Z][A-Za-z0-9-]*)\b([^>]*)\/>/g, (_, tag, attrs) => resolveSelfClosingJsx(tag, attrs));
    // paired uppercase component tags: transform via lookup or keep inner text
    t = t.replace(/<([A-Z][A-Za-z0-9-]*)\b([^>]*)>([\s\S]*?)<\/\1>/g, (_, tag, attrs, inner) => {
      const fn = JSX_PAIRED_TRANSFORMS.get(tag.toLowerCase());
      return fn ? fn(inner.trim(), attrs) : inner.trim();
    });
    if (t === before) break;
  }
  return t;
}

// '<span class="x">text</span>' → 'text'   '<div id="y">text</div>' → 'text'
function unwrapAttributedSpans(text) {
  let t = text;
  for (let k = 0; k < 8; k++) {
    const before = t;
    t = t.replace(/<(span|div)\s[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => inner.trim());
    if (t === before) break;
  }
  return t;
}

// '<tr><td>a</td><td>b</td></tr>' → '| a | b |\n'   <li> items joined with " / "
function convertTableRows(text) {
  return text.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (m, inner) => {
    const cells = [];
    inner.replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi, (_, cell) => {
      // extract <li> items first; join with " / " to keep items distinct
      const liItems = [];
      cell.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (__, liContent) => {
        const item = liContent.replace(STRIP_TAGS, ' ').replace(/\s+/g, ' ').trim();
        if (item) liItems.push(item);
      });
      if (liItems.length) {
        cells.push(liItems.join(' / '));
      } else {
        const flat = cell.replace(STRIP_TAGS, ' ').replace(/\s+/g, ' ').trim();
        if (flat) cells.push(flat);
      }
    });
    if (!cells.length) return '';
    // drop rows where all cells are empty after stripping
    if (cells.every(c => !c)) return '';
    return '| ' + cells.join(' | ') + ' |\n';
  });
}

// '<a href="/x">label</a>' → '[label](/x)'   '<tr><td>a</td><td>b</td></tr>' → '| a | b |'
function convertHtmlToMarkdown(text) {
  let t = text;
  for (let k = 0; k < 8; k++) {
    const before = t;
    t = t.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (m, attrs, inner) => {
      const hm = attrs.match(HREF_ATTR);
      const url = hm ? (hm[1] || hm[2]) : '';
      const label = inner.replace(STRIP_TAGS, '').trim();
      if (url && label) return `[${label}](${url})`;
      // Icon-only link (label stripped to empty but real URL present): preserve URL as bare path.
      // Skip Vue/template binding expressions like ":href" values that start with quotes or JS.
      if (url && /^(https?:|\/|#)/.test(url)) return url;
      return label || inner;
    });
    if (t === before) break;
  }
  // convert <iframe>/<video> with src → video (url)
  t = convertMediaEmbeds(t);
  // convert <tr> rows: wrap cells with | separators to preserve column meaning
  t = convertTableRows(t);
  // strip remaining wrapper/void tags, decode entities, drop blank lines
  return stripRemainingHtmlTags(t);
}

// strips wrapper/void tags keeping inner content; decodes entities; collapses blank lines
function stripRemainingHtmlTags(text) {
  let t = text;
  for (let k = 0; k < 8; k++) {
    const before = t;
    t = t.replace(/<([A-Za-z][A-Za-z0-9-]*)\b[^>]*>([\s\S]*?)<\/\1>/g, (m, tag, inner) => {
      const key = tag.toLowerCase();
      if (WRAPPER_TAGS.has(key) || VOID_TAGS.has(key)) return inner;
      return m;
    });
    t = t.replace(/<([A-Za-z][A-Za-z0-9-]*)\b[^>]*\/>/g, (m, tag) =>
      VOID_TAGS.has(tag.toLowerCase()) ? '' : m);
    if (t === before) break;
  }
  t = decodeEntities(t);
  t = t.split('\n').map(line => line.trim()).filter(line => line !== '').join('\n');
  return collapseBlankLines(t).trim();
}

const INLINE_HTML_TAGS = new Set(['em', 'i', 'strong', 'b', 's', 'del', 'ins', 'sup', 'sub', 'small', 'mark', 'code', 'kbd', 'abbr', 'cite', 'q', 'u', 'samp', 'var', 'details', 'summary']);

// 'text <em>bold</em> end' → 'text bold end'   '<br/>' → ' '   block tags untouched
function stripInlineHtml(text) {
  if (!text.includes('<')) return text;
  let t = text;
  // <br> / <br/> → space
  t = t.replace(/<br\s*\/?>/gi, ' ');
  // Strip inline tags only — loop until stable (handles nesting).
  // Deliberately excludes block-level tags like <pre>, <div> so we don't swallow
  // content inside containers that are not in our set.
  for (let k = 0; k < 8; k++) {
    const before = t;
    t = t.replace(/<([a-z][a-z0-9]*)\b[^>]*>([^<]*?)<\/\1>/gi, (m, tag, inner) =>
      INLINE_HTML_TAGS.has(tag.toLowerCase()) ? inner : m);
    t = t.replace(/<([a-z][a-z0-9]*)\b[^>]*\/>/gi, (m, tag) =>
      INLINE_HTML_TAGS.has(tag.toLowerCase()) ? '' : m);
    if (t === before) break;
  }
  // Strip orphan opening/closing tags (no matching pair in this text) for inline set members
  t = t.replace(/<([a-z][a-z0-9]*)\b[^>]*>/gi, (m, tag) =>
    INLINE_HTML_TAGS.has(tag.toLowerCase()) ? '' : m);
  t = t.replace(/<\/([a-z][a-z0-9]*)>/gi, (m, tag) =>
    INLINE_HTML_TAGS.has(tag.toLowerCase()) ? '' : m);
  return t;
}


// '| a  b |  c |' → '| a b | c |'   '| --- | ---- |' → '| - | - |'
function compactTableCells(text) {
  return text.split('\n').map((line) => {
    const m = line.match(/^(\s*)\|/);
    if (!m) return line;
    const indent = m[1];
    const rest = line.slice(indent.length);
    const isSep = /^\|[\s\-:|]+\|?\s*$/.test(rest);
    const s = isSep
      ? rest.replace(/-{2,}/g, '-')          // separator row: collapse dash runs only
      : collapseSpacesOutsideBackticks(rest); // cell content: collapse spaces only
    return indent + s;
  }).join('\n');
}

const LOG_FENCE_OPENER = /^\s*(`{3,}|~{3,})log\s*$/i;
const PATH_LINE = /^\s+([\S]+\/[^\s]+)\s*$/;

function dirOf(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

// 6 lines all in src/foo/ → [first, '   ...', last];  ≤3 lines → kept as-is
function collapsePathRuns(lines) {
  const out = [];
  let run = [];
  let runDir = null;

  const flushRun = () => {
    if (!run.length) return;
    if (run.length <= 3) {
      out.push(...run);
    } else {
      out.push(run[0]);
      out.push(`   ...`);
      out.push(run[run.length - 1]);
    }
    run = [];
    runDir = null;
  };

  for (const line of lines) {
    const m = PATH_LINE.exec(line);
    if (m) {
      const dir = dirOf(m[1]);
      if (dir === runDir) {
        run.push(line);
      } else {
        flushRun();
        run = [line];
        runDir = dir;
      }
    } else {
      flushRun();
      out.push(line);
    }
  }
  flushRun();
  return out;
}

// strips [!code focus] annotation from lines and returns only those lines
function keepFocusLines(lines) {
  return lines.map(l =>
    l.replace(/\s*\/\/\s*\[!code focus\]/g, '').replace(/\s*#\s*\[!code focus\]/g, '').trimEnd()
  );
}

// collapses same-dir path runs in inner fence lines to first/…/last
function collapsePathsInFence(lines) {
  return collapsePathRuns(lines);
}

// [!code focus] lines → keep only those (stripped); else collapse path runs
function collapseLogDump(text) {
  const lines = text.split('\n');
  const inner = lines.slice(1, -1);
  const focusLines = inner.filter(l => l.includes('[!code focus]'));
  const collapsed = focusLines.length ? keepFocusLines(focusLines) : collapsePathsInFence(inner);
  return [lines[0], ...collapsed, lines[lines.length - 1]].join('\n');
}

const IMPL_DIV_LABEL = {
  'java-div': 'Java:',
  'node-div': 'Node.js:',
};

function normalizeMdTable(text, source) {
  const normalized = normalizeStructural(text);
  const compacted = compactTableCells(normalized);
  const noMarkers = stripClassMarkers(compacted);
  const noJsx = stripJsxComponents(noMarkers);
  const noInline = stripInlineHtml(noJsx);
  const decoded = decodeEntities(noInline);
  return flattenLinks(resolveRelativeLinks(decoded, source));
}

function normalizeContainerOpener(text, source) {
  const noMarkers = stripClassMarkers(text.trim());
  const noInline = stripInlineHtml(noMarkers);
  return flattenLinks(resolveRelativeLinks(noInline, source));
}

function normalizeAdmonitionOpener(text) {
  const noMarkers = stripClassMarkers(text);
  const noJsx = stripJsxComponents(noMarkers);
  const noSpans = unwrapAttributedSpans(noJsx);
  return stripInlineHtml(noSpans);
}

function normalizeListItem(text, source) {
  const noMarkers = stripClassMarkers(text);
  const noComponents = unwrapAttributedSpans(stripJsxComponents(noMarkers));
  const stripped = stripImageMarkup(noComponents).trim();
  const noInline = stripInlineHtml(stripped);
  const decoded = decodeEntities(noInline);
  const spaced = decoded.split('\n').map(collapseSpacesOutsideBackticks).join('\n');
  return flattenLinks(resolveRelativeLinks(spaced, source));
}

function normalizeProse(text, source) {
  const normalized = normalizeShared(text);
  const noMarkers = stripClassMarkers(normalized);
  const noComponents = unwrapAttributedSpans(stripJsxComponents(noMarkers));
  const stripped = stripImageMarkup(noComponents).trim();
  const decoded = decodeEntities(stripped);
  const spaced = decoded.split('\n').map(collapseSpacesOutsideBackticks).join('\n');
  return flattenLinks(resolveRelativeLinks(spaced, source));
}

function transformParts(block, source) {
  const parts = block.parts ?? fallbackParts(block);
  const transformedParts = parts
    .map(b => { b.text = transformBlocks(b, source); return b; })
    .filter(b => !b.isEmpty)
    .map(b => b.text);
  const lists = ['list-item', 'bullet-item']
  const join = lists.includes(block.type) ? '\n' : '\n\n'
  return transformedParts.join(join);
}

export function transformBlocks(block, source) {
  let text = '';
  const inner = block.parts?.length > 0 ? transformParts(block, source) : null;

  switch (block.type) {
    case 'heading':
    case 'redirect':
    case 'paragraph': {
      text = normalizeProse(block.text, source);
      break;
    }
    default: {
      throw new Error(`[transformBlocks] no type for ${block.text}`);
    }
  }

  if (text.trim() === '') {
    block.isEmpty = true;
  }

  return text;
}
