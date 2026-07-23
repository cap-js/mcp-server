// Token accounting + cost model for the Level-B eval.
//
// Prices are USD per 1M tokens. EDIT to match the model(s) you actually run
// the eval with, and keep them versioned so historical results stay comparable.
// (Cache-read/write tiers included because MCP tool results and skill context
// are prime caching candidates — a naive input count overstates their cost.)
export const PRICING = {
  // model id            input   output  cacheRead cacheWrite
  'claude-sonnet-5':   { in: 3.0, out: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-8':   { in: 15.0, out: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-haiku-4-5':  { in: 0.8, out: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  // fallback used if the row's model is unknown
  default:             { in: 3.0, out: 15.0, cacheRead: 0.3, cacheWrite: 3.75 }
}

/**
 * Normalize whatever an agent runtime reports into a stable usage shape.
 * All fields default to 0 so partial telemetry never NaNs the aggregation.
 */
export function normalizeUsage(raw = {}) {
  return {
    input: raw.input ?? raw.input_tokens ?? 0,
    output: raw.output ?? raw.output_tokens ?? 0,
    cacheRead: raw.cacheRead ?? raw.cache_read_input_tokens ?? 0,
    cacheWrite: raw.cacheWrite ?? raw.cache_creation_input_tokens ?? 0,
    // tokens attributable to tool results (e.g. search_docs output). Optional
    // but valuable for MCP arms — set it in runAgent if your runtime exposes it.
    toolResult: raw.toolResult ?? 0
  }
}

/** Total tokens billed (all tiers), for a quick single-number view. */
export function totalTokens(u) {
  return u.input + u.output + u.cacheRead + u.cacheWrite
}

/** USD cost for one run's usage under the given model. */
export function costUSD(u, model) {
  const p = PRICING[model] || PRICING.default
  return (
    (u.input * p.in +
      u.output * p.out +
      u.cacheRead * p.cacheRead +
      u.cacheWrite * p.cacheWrite) /
    1_000_000
  )
}
