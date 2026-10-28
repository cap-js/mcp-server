// Recursively collects every node's raw heading line into a flat Set.
export function flattenNodes(nodes) {
  const result = new Set();
  for (const node of nodes) {
    result.add(node.raw);
    for (const raw of flattenNodes(node.children)) result.add(raw);
  }
  return result;
}

// Returns the set of runtime labels ('java', 'node') reachable from a block.
// Checks block.runtime first; if absent, recurses into block.parts.
export function runtimesOf(b) {
  if (b.runtime) return new Set([b.runtime]);
  const s = new Set();
  if (b.parts) for (const p of b.parts) for (const r of runtimesOf(p)) s.add(r);
  return s;
}

// True when a block belongs exclusively to one runtime (no other runtimes present).
export function isPure(b, runtime) {
  const s = runtimesOf(b);
  return s.size === 1 && s.has(runtime);
}

// Returns a copy of b with parts belonging to the opposite runtime filtered out.
// Rebuilds b.text from the kept parts' already-transformed texts.
// Returns b unchanged when nothing needs to be dropped.
export function projectForRuntime(b, runtime) {
  const other = runtime === 'java' ? 'node' : 'java';
  if (!b.parts || !runtimesOf(b).has(other)) return b;
  const kept = b.parts.filter(p => !runtimesOf(p).has(other));
  const join = ['list', 'list-item', 'bullet-item'].includes(b.type) ? '\n' : '\n\n';
  let text = kept.map(p => p.text).join(join);
  if (b.opener) text = `${b.opener}\n${text}${b.closer ? '\n' + b.closer.trim() : ''}`;
  return { ...b, text };
}
