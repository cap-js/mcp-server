// Shared regular expressions and text utilities for the chunker stages.
// Import from this module instead of from individual stage files.

// --- Fence patterns ---
export const FENCE_OPENER = /^(\s*)(```+|~~~+)/;
export const FENCE_CLOSER = /^(\s*)(```+|~~~+)\s*$/;

// --- Container / div patterns ---
export const CONTAINER_OPENER = /^>?\s*:{2,}\s*[^\s:]/;
export const CONTAINER_CLOSER = /^>?\s*:{2,}\s*$/;
export const JAVA_NODE_DIV_OPEN = /^<div\s+class="(impl\s+)?(java|node)(\s+[^"]*)?"/i;
export const COLS_DIV_OPEN = /^<div\s+class="cols-\d+"/i;
export const HTML_DIV_CLOSE = /^<\/div>/i;
export const HTML_ANY_DIV_OPEN = /^<div\b(?![^>]*\/>)/i;

// --- Heading pattern ---
export const MD_HEADING = /^(\s*#{1,6}) (.+)$/;

// --- HTML stub pattern ---
const HTML_STUB = /^<[A-Za-z][^>]*\/>\s*$|^<[A-Za-z][A-Za-z0-9]*(?:\s[^>]*)?>?\s*$|^<\/[A-Za-z][A-Za-z0-9]*>\s*$|^<([A-Za-z][A-Za-z0-9]*)(?:\s[^>]*)?>[\s]*<\/\1>\s*$/;

// Returns true when `line` is a self-contained HTML stub (void tag, opener only, or empty element).
export function isHtmlStub(line) {
  return HTML_STUB.test(line.trim());
}

// Returns the first non-empty, non-stub line of `text`.
export function firstMeaningfulLine(text) {
  for (const line of text.split('\n')) {
    if (line.trim() !== '' && !isHtmlStub(line)) return line;
  }
  return '';
}

// Returns the last non-empty, non-stub line of `text`.
export function lastMeaningfulLine(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '' && !isHtmlStub(lines[i])) return lines[i];
  }
  return '';
}

// Returns true when `value` is missing — not a string, or blank.
export function isMissing(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}
