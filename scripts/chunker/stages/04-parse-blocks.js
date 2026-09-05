import { isHeadingLine, MD_HEADING } from './01-parse.js'

// Regex patterns for block and cut-point detection
export const CONTAINER_OPENER = /^>?\s*:::\s*\S/;
export const CONTAINER_CLOSER = /^>?\s*:::+\s*$/;
export const JAVA_NODE_DIV_OPEN = /^<div\s+class="(impl\s+)?(java|node)(\s+[^"]*)?"/i;
export const COLS_DIV_OPEN = /^<div\s+class="cols-\d+"/i;
export const HTML_DIV_CLOSE = /^<\/div>/i;
export const HTML_ANY_DIV_OPEN = /^<div\b(?![^>]*\/>)/i;
export const ANAPHORIC_WORDS = [ 'These ', 'Those ', 'They ' ];
export const LEAD_IN_PATTERNS = [
  /^(?!\s*::+\s*$).*:\s*$/,
  /as follows/i,
  /shown below/i,
  /listed below/i,
  /as shown/i,
  /like this/i,
  /the following/i,
  /outlined below/i,
];
const FENCE_OPENER = /^(\s*)(```+|~~~+)/;
const HTML_TABLE_OPEN = /^<table(\s|>)/i;
const HTML_TABLE_CLOSE = /^<\/table>/i;
const NUMBERED_ITEM = /^\d+\.\s/;
const BULLET_ITEM = /^\s*[-*+]\s/;
// Captures leading indent + bullet marker in one exec — avoids double-match per line
const BULLET_INDENT = /^(\s*)[-*+]\s/;
const MARKDOWN_TABLE_ROW = /^\s*\|/;
const GFM_ADMONITION = /^>\s*\[!(tip|note|warning|important|info|danger|caution)\]/i;
const BLOCKQUOTE_LINE = /^>/;
const HTML_STUB = /^<[A-Za-z][^>]*\/>\s*$|^<[a-z][a-z0-9]*(?:\s[^>]*)?>?\s*$|^<\/[a-z]+>\s*$|^<([a-z][a-z0-9]*)(?:\s[^>]*)?>[\s]*<\/\1>\s*$/;
const REDIRECT = /\{\s*\.?\s*learn-more\}\s*$/;

function isLeadInCheck(line) {
  const t = line.trimEnd();
  return LEAD_IN_PATTERNS.some(re => re.test(t));
}

function isAnaphoricCheck(line) {
  const t = line.trimStart();
  return ANAPHORIC_WORDS.some(w => t.startsWith(w));
}

export function firstMeaningfulLine(text) {
  for (const line of text.split('\n')) {
    if (line.trim() !== '' && !isHtmlStub(line)) return line;
  }
  return '';
}

export function lastMeaningfulLine(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '' && !isHtmlStub(lines[i])) return lines[i];
  }
  return '';
}

export function isHtmlStub(line) {
  return HTML_STUB.test(line.trim());
}

let outputParse
export function parseBlocks(body, flattenedParse) {
  if (!outputParse) outputParse = flattenedParse
  return parseBlockLines(body.split('\n'), outputParse);
  outputParse = undefined
}

function parseBlockLines(lines) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- Skip blank lines between blocks ---
    if (line.trim() === '') {
      i++;
      continue;
    }

    // --- Code fence ---
    const fenceMatch = FENCE_OPENER.exec(line);
    if (fenceMatch) {
      const fenceChar = fenceMatch[2][0];
      const fenceLen = fenceMatch[2].length;
      const fenceLines = [line];
      const startI = i;
      i++;
      while (i < lines.length) {
        const l = lines[i];
        fenceLines.push(l);
        const cm = FENCE_OPENER.exec(l);
        if (i > startI && cm && cm[2][0] === fenceChar && cm[2].length >= fenceLen) {
          i++;
          break;
        }
        i++;
      }
      blocks.push({ text: fenceLines.join('\n'), type: 'fence', supressCut: true });
      continue;
    }

    // --- ::: container ---
    if (CONTAINER_OPENER.test(line)) {
      const containerLines = [line];
      let depth = 1;
      i++;
      while (i < lines.length && depth > 0) {
        const l = lines[i];
        containerLines.push(l);
        if (CONTAINER_OPENER.test(l)) depth++;
        else if (CONTAINER_CLOSER.test(l)) depth = 0;
        i++;
      }
      const lastLine = containerLines[containerLines.length - 1];
      const hasCloser = CONTAINER_CLOSER.test(lastLine.trim());
      const innerLines = containerLines.slice(1, hasCloser ? -1 : undefined);
      const parts = parseBlockLines(innerLines);
      let opener, closer
      if (!containerLines[0].includes('code-group')) {
        opener = containerLines[0];
        closer = hasCloser ? lastLine : ':::';
      }
      blocks.push({ opener, closer, type: 'container', supressCut: true, parts });
      continue;
    }

    // --- HTML <table> ---
    if (HTML_TABLE_OPEN.test(line)) {
      const tableLines = [line];
      let depth = 1;
      i++;
      while (i < lines.length && depth > 0) {
        const l = lines[i];
        tableLines.push(l);
        if (HTML_TABLE_OPEN.test(l)) depth++;
        if (HTML_TABLE_CLOSE.test(l)) depth--;
        i++;
      }
      blocks.push({ text: tableLines.join('\n'), type: 'html-table', supressCut: true, parts: [] });
      continue;
    }

    // --- <div class="..."> content block ---
    const javaNodeMatch = JAVA_NODE_DIV_OPEN.exec(line);
    if (javaNodeMatch) {
      const divLines = [line];
      let depth = 1;
      i++;
      while (i < lines.length && depth > 0) {
        const l = lines[i];
        divLines.push(l);
        if (HTML_ANY_DIV_OPEN.test(l)) depth++;
        if (HTML_DIV_CLOSE.test(l)) depth--;
        i++;
      }
      const type = javaNodeMatch[2].toLowerCase() === 'java' ? 'java-div' : 'node-div';
      const lastLine = divLines[divLines.length - 1];
      const hasCloser = HTML_DIV_CLOSE.test(lastLine.trim());
      const innerLines = divLines.slice(1, hasCloser ? -1 : undefined);
      const parts = parseBlockLines(innerLines);
      const opener = divLines[0];
      if (!hasCloser) throw new Error(`[parseBlocks] no closer for ${opener}`);
      if (parts.length === 0) throw new Error(`[parseBlocks] no parts for ${line}`);
      const closer = lastLine
      blocks.push({ opener, closer, type, supressCut: false, parts });
      continue;
    }

    // --- <div class="cols-N"> layout block ---
    if (COLS_DIV_OPEN.test(line)) {
      const divLines = [line];
      let depth = 1;
      i++;
      while (i < lines.length && depth > 0) {
        const l = lines[i];
        divLines.push(l);
        if (HTML_ANY_DIV_OPEN.test(l)) depth++;
        if (HTML_DIV_CLOSE.test(l)) depth--;
        i++;
      }
      const lastLine = divLines[divLines.length - 1];
      const hasCloser = HTML_DIV_CLOSE.test(lastLine.trim());
      const innerLines = divLines.slice(1, hasCloser ? -1 : undefined);
      const parts = parseBlockLines(innerLines);
      if (parts.length === 0 ) throw new Error(`[parseBlocks] no parts for ${line}`)
      blocks.push({ type: 'cols-div', supressCut: false, parts });
      continue;
    }

    // --- Markdown pipe table ---
    if (MARKDOWN_TABLE_ROW.test(line)) {
      const tableLines = [line];
      i++;
      while (i < lines.length && MARKDOWN_TABLE_ROW.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({ text: tableLines.join('\n'), type: 'md-table', supressCut: true, parts: [] });
      continue;
    }

    // --- Numbered list ---
    if (NUMBERED_ITEM.test(line)) {
      const items = [];
      let opener = line;
      let bodyLines = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          let j = i + 1;
          if (NUMBERED_ITEM.test(lines[j])) {
            items.push({ text: opener, opener, bodyLines }); opener = lines[j]; bodyLines = [];
            i += 2;
            continue;
          }
          while (j < lines.length && lines[j].trim() === '') j++;
          const currIndentLength = /^(\s+)/.exec(lines[j] || '')?.[1].length ?? 0;
          if (j < lines.length && currIndentLength) {
            i++;
            continue;
          } else {
            break;
          }
        }
        if (NUMBERED_ITEM.test(l)) {
          items.push({ text: opener, opener, bodyLines }); opener = l; bodyLines = [];
          i++;
          continue;
        }
        bodyLines.push(l);
        i++;
      }
      items.push({ text: opener, opener, bodyLines });
      for (const item of items) {
        let itemOpener;
        let parts = [];
        let itemText
        if (item.bodyLines.length) {
          itemOpener = item.opener;
          parts = parseBlockLines(item.bodyLines);
          if (parts.length === 0) throw new Error(`[parseBlocks] no numbered list parts for ${line}`)
        } else {
          itemText = item.text
        }
        blocks.push({ text: itemText, opener: itemOpener, closer: null, type: 'list-item', supressCut: true, parts });
      }
      continue;
    }

    // --- GFM admonition blockquote ---
    if (GFM_ADMONITION.test(line)) {
      const admonLines = [line];
      i++;
      while (i < lines.length && BLOCKQUOTE_LINE.test(lines[i])) {
        admonLines.push(lines[i]);
        i++;
      }
      const innerLines = admonLines.slice(1).map(l => l.replace(/^\s*>\s/, ''));
      const parts = parseBlockLines(innerLines);
      let opener
      let admonText
      if (parts.length > 0 ) {
        opener =  admonLines[0]
      } else {
        admonText = admonLines.join('\n')
      }
      blocks.push({ text: admonText, opener, type: 'admonition', supressCut: true, parts });
      continue;
    }

    // --- Bullet list ---
    const bulletMatch = BULLET_INDENT.exec(line);
    if (bulletMatch) {
      const openerIndent = bulletMatch[1].length;
      const isTopLevel = (l) => { const m = BULLET_INDENT.exec(l); return m !== null && m[1].length === openerIndent; };
      const items = [];
      let opener = line;
      let bodyLines = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && isTopLevel(lines[j])) {
            i++;
            continue;
          }
          const currIndentLength = /^(\s+)/.exec(lines[j] || '')?.[1].length ?? 0;
          if (j < lines.length && currIndentLength > 0) {
            i++;
            continue;
          } else {
            break;
          }
        }
        if (isTopLevel(l)) {
          items.push({ text: opener, opener, bodyLines }); opener = l; bodyLines = [];
          i++;
          continue;
        }
        bodyLines.push(l);
        i++;
      }
      items.push({ text: opener, opener, bodyLines });
      for (const item of items) {
        let itemOpener;
        let parts = [];
        let itemText
        if (item.bodyLines.length) {
          itemOpener = item.opener;
          parts = parseBlockLines(item.bodyLines);
          if (parts.length === 0) throw new Error(`[parseBlocks] no bullet list parts for ${line}`)
        } else {
          itemText = item.text
        }
        blocks.push({ text: itemText, opener: itemOpener, closer: null, type: 'bullet-item', supressCut: true, parts });
      }
      continue;
    }

    // --- Redirect / learn-more link ---
    if (REDIRECT.test(line)) {
      blocks.push({ text: line, type: 'redirect', supressCut: true, parts: [] });
      i++;
      continue;
    }

    // --- Heading ---
    if (MD_HEADING.test(line)) {
      const heading = isHeadingLine(lines, i);
      const hasBody = i !== lines.length - 1
      // with source
      if (heading) {
        i = heading.sourceIndex + 1;
        if (hasBody) {
          blocks.push({ text: line, type: 'heading', supressCut: false, isLeadIn: true });
        }
        continue;
      } 
      // without source
      else if (outputParse?.has(line)) {
        i++;
        if (hasBody) {
          blocks.push({ text: line, type: 'heading', supressCut: false, isLeadIn: true });
        }
        continue;
      }
    }

    // --- Regular paragraph ---
    const paraLines = [line];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (FENCE_OPENER.test(l) || CONTAINER_OPENER.test(l) || HTML_TABLE_OPEN.test(l) || JAVA_NODE_DIV_OPEN.test(l) || COLS_DIV_OPEN.test(l) || MARKDOWN_TABLE_ROW.test(l) || NUMBERED_ITEM.test(l) || BULLET_ITEM.test(l) || REDIRECT.test(l)) break;
      paraLines.push(l);
      i++;
    }
    // Scan paraLines directly — avoids split('\n') inside firstMeaningfulLine/lastMeaningfulLine
    let firstLine = '';
    for (const l of paraLines) { if (l.trim() !== '' && !isHtmlStub(l)) { firstLine = l; break; } }
    let lastLine = '';
    for (let k = paraLines.length - 1; k >= 0; k--) { if (paraLines[k].trim() !== '' && !isHtmlStub(paraLines[k])) { lastLine = paraLines[k]; break; } }
    blocks.push({ text: paraLines.join('\n'), type: 'paragraph', supressCut: false, isAnaphoric: isAnaphoricCheck(firstLine), isLeadIn: isLeadInCheck(lastLine) });
  }

  return blocks;
}
