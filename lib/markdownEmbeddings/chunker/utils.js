// Shared regular expressions and utilities for the chunker pipeline and stages.

// --- Fence patterns ---
export const FENCE_OPENER = /^(\s*)(```+|~~~+)/
export const FENCE_CLOSER = /^(\s*)(```+|~~~+)\s*$/

// --- Container / div patterns ---
export const CONTAINER_OPENER = /^>?\s*:{2,}\s*[^\s:]/
export const CONTAINER_CLOSER = /^>?\s*:{2,}\s*$/
export const COLS_DIV_OPEN = /^<div\s+class="cols-\d+"/i
export const HTML_DIV_CLOSE = /^<\/div>/i
export const HTML_ANY_DIV_OPEN = /^<div\b(?![^>]*\/>)/i

// --- Heading pattern ---
export const MD_HEADING = /^(\s*#{1,6}) (.+)$/

// --- Text utilities ---
const HTML_STUB =
  /^<[A-Za-z][^>]*\/>\s*$|^<[A-Za-z][A-Za-z0-9]*(?:\s[^>]*)?>?\s*$|^<\/[A-Za-z][A-Za-z0-9]*>\s*$|^<([A-Za-z][A-Za-z0-9]*)(?:\s[^>]*)?>[\s]*<\/\1>\s*$/

// Returns true when `line` is a self-contained HTML stub (void tag, opener only, or empty element).
export function isHtmlStub(line) {
  return HTML_STUB.test(line.trim())
}

// Returns the first non-empty, non-stub line of `text`.
export function firstMeaningfulLine(text) {
  for (const line of text.split('\n')) {
    if (line.trim() !== '' && !isHtmlStub(line)) return line
  }
  return ''
}

// Returns the last non-empty, non-stub line of `text`.
export function lastMeaningfulLine(text) {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '' && !isHtmlStub(lines[i])) return lines[i]
  }
  return ''
}

// Returns true when `value` is missing — not a string, or blank.
export function isMissing(value) {
  return typeof value !== 'string' || value.trim().length === 0
}

// --- Heading tree utilities ---
// Recursively collects every node's raw heading line into a flat Set.
export function flattenNodes(nodes) {
  const result = new Set()
  for (const node of nodes) {
    result.add(node.raw)
    for (const raw of flattenNodes(node.children)) result.add(raw)
  }
  return result
}
