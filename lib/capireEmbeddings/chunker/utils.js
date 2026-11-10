// Shared regular expressions and utilities for the chunker pipeline and stages.

// --- Fence patterns ---
export const FENCE_OPENER = /^(\s*)(```+|~~~+)/
export const FENCE_CLOSER = /^(\s*)(```+|~~~+)\s*$/

// --- Container / div patterns ---
export const CONTAINER_OPENER = /^>?\s*:{2,}\s*[^\s:]/
export const CONTAINER_CLOSER = /^>?\s*:{2,}\s*$/
export const JAVA_NODE_DIV_OPEN = /^<div\s+class="(impl\s+)?(java|node)(\s+[^"]*)?"/i
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

// --- Runtime utilities ---
// Returns the set of runtime labels ('java', 'node') reachable from a block.
// Checks block.runtime first; if absent, recurses into block.parts.
export function runtimesOf(b) {
  if (b.runtime) return new Set([b.runtime])
  const s = new Set()
  if (b.parts) for (const p of b.parts) for (const r of runtimesOf(p)) s.add(r)
  return s
}

// True when a block belongs exclusively to one runtime (no other runtimes present).
export function isPure(b, runtime) {
  const s = runtimesOf(b)
  return s.size === 1 && s.has(runtime)
}

// Returns a copy of b with parts belonging to the opposite runtime filtered out.
// Rebuilds b.text from the kept parts' already-transformed texts.
// Returns b unchanged when nothing needs to be dropped.
export function projectForRuntime(b, runtime) {
  const other = runtime === 'java' ? 'node' : 'java'
  if (!b.parts || !runtimesOf(b).has(other)) return b
  const kept = b.parts.filter((p) => !runtimesOf(p).has(other))
  const join = ['list', 'list-item', 'bullet-item'].includes(b.type) ? '\n' : '\n\n'
  let text = kept.map((p) => p.text).join(join)
  if (b.opener) text = `${b.opener}\n${text}${b.closer ? '\n' + b.closer.trim() : ''}`
  return { ...b, text }
}
