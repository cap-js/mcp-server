import fs from 'fs/promises'

// Parse a JSON file, or null when it does not exist.
export async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export function mean(values) {
  if (values.length === 0) return 0
  let s = 0
  for (const v of values) s += v
  return s / values.length
}

export function round(value, dp) {
  const f = Math.pow(10, dp)
  // Round on magnitude so negatives round symmetrically with positives (e.g.
  // -0.005 → -0.01, mirroring 0.005 → 0.01). Epsilon counters binary-float
  // representation of exact halves so rounding is stable across platforms.
  const r = (Math.sign(value) * Math.round(Math.abs(value) * f + Number.EPSILON)) / f
  return r === 0 ? 0 : r // normalise -0 → 0
}
