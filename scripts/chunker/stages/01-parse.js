import { CONTAINER_OPENER, CONTAINER_CLOSER, HTML_DIV_CLOSE, HTML_ANY_DIV_OPEN, COLS_DIV_OPEN, JAVA_NODE_DIV_OPEN } from './04-parse-blocks.js';

export const MD_HEADING = /^(\s*#{1,6}) (.+)$/;

const SOURCE_LINE = /^>?\s*Source:\s/;

export function isHeadingLine(lines, index) {
  const match = MD_HEADING.exec(lines[index]);
  if (!match) return null;
  const window = lines.slice(index + 1, index + 4);
  const offset = window.findIndex(l => /^>?\s*Source:\s/.test(l));
  if (offset === -1) return null;
  const source = window[offset].replace(/^>?\s*Source:\s*/, '')
  return { depth: match[1].length, title: match[2].trim(), source, sourceIndex: index + 1 + offset };
}

function isNotInsideContainer(lines, lastHeadingIndex, index) {
  for (let i = index - 1; i >= lastHeadingIndex; i--) {
    const line = lines[i]
    if (CONTAINER_OPENER.test(line)) return false
    if (CONTAINER_CLOSER.test(line)) return true
  }
  return true
}

function isNotInsideJavaNodeDivOrColDiv(lines, lastHeadingIndex, index) {
  let closesSeen = 0;
  for (let i = index - 1; i >= lastHeadingIndex; i--) {
    const line = lines[i];
    if (HTML_DIV_CLOSE.test(line)) { closesSeen++; continue; }
    if (HTML_ANY_DIV_OPEN.test(line)) {
      if (closesSeen > 0) { closesSeen--; continue; } // this opener matched a closer we already saw
      // Unclosed opener — only suppress heading if it's a special div
      if (JAVA_NODE_DIV_OPEN.test(line) || COLS_DIV_OPEN.test(line)) return false;
    }
  }
  return true;
}

export function parse(text, config) {
  const lines = text.split('\n');
  const roots = [];
  const stack = [];
  let buffer = [];
  let preamble = null;

  const flushBuffer = () => {
    const raw = buffer.join('\n');
    buffer = [];
    if (stack.length > 0) {
      stack[stack.length - 1].body = raw.split('\n').filter(l => !SOURCE_LINE.test(l)).join('\n').trimStart();
    } else if (raw.trim() !== '') {
      if (!preamble) {
        preamble = { depth: 0, title: '', raw: '', children: [], source: '', body: '' };
      }
      preamble.body = raw.split('\n').filter(l => !SOURCE_LINE.test(l)).join('\n').trimStart();
    }
  };

  let lastHeadingIndex = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = isHeadingLine(lines, i);

    if (heading && isNotInsideContainer(lines, lastHeadingIndex, i) && isNotInsideJavaNodeDivOrColDiv(lines, lastHeadingIndex, i)) {
      lastHeadingIndex = i
      flushBuffer();

      const node = {
        depth: heading.depth,
        title: heading.title,
        raw: line,
        children: [],
        source: heading.source,
        body: '',
      };

      while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) {
        stack.pop();
      }

      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else {
        roots.push(node);
      }

      stack.push(node);
    } else {
      buffer.push(line);
    }
  }

  flushBuffer();

  if (preamble) {
    process.stderr.write(`[parse] warning: preamble content found before first heading\n`);
  }

  return roots;
}
