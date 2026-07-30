import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs/promises'

// evals/ root (this file lives in evals/lib/)
export const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const METRIC_KEYS = ['recall_at_k', 'mrr', 'precision_at_k', 'hit_rate_at_k', 'ndcg_at_k']
export const GATED_KEYS = ['recall_at_k', 'mrr', 'hit_rate_at_k']
export const METRIC_LABEL = {
  recall_at_k: 'Recall',
  mrr: 'MRR',
  precision_at_k: 'Precision',
  hit_rate_at_k: 'Hit-Rate',
  ndcg_at_k: 'nDCG'
}

function envNum(name, fallback) {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`Env ${name}="${v}" is not a number`)
  return n
}

function envStr(name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

// Parse a per-metric gate override like "recall_at_k=0.85,mrr=0.7,ndcg_at_k=null"
function parseGateOverrides(str) {
  const out = {}
  for (const pair of str.split(',')) {
    const [k, v] = pair.split('=').map(s => s && s.trim())
    if (!k) continue
    if (!METRIC_KEYS.includes(k)) throw new Error(`EVAL_GATES: unknown metric "${k}"`)
    out[k] = v === 'null' ? null : Number(v)
  }
  return out
}

// Load and resolve the effective configuration.
// Precedence: env vars > config.json > built-in defaults.
export async function loadConfig({ configPath, overrides } = {}) {
  const cfgPath = configPath
    ? path.resolve(configPath)
    : envStr('EVAL_CONFIG', path.join(EVALS_DIR, 'config.json'))

  let file = {}
  try {
    file = JSON.parse(await fs.readFile(cfgPath, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    // No config.json → pure defaults + env.
  }

  const paths = file.paths || {}
  const gatesFile = { ...(file.gates || {}) }
  delete gatesFile.$comment
  const output = file.output || {}

  const resolve = p => (path.isAbsolute(p) ? p : path.join(EVALS_DIR, p))

  const cfg = {
    configPath: cfgPath,
    k: envNum('EVAL_K', file.k ?? 5),
    capire_version: envStr('EVAL_CAPIRE_VERSION', file.capire_version || 'unknown'),
    paths: {
      goldenSet: resolve(envStr('EVAL_GOLDEN_SET', paths.goldenSet || 'data/golden-set.json')),
      runsDir: resolve(envStr('EVAL_RUNS_DIR', paths.runsDir || 'runs'))
    },
    gates: {},
    output: {
      keepRuns: envNum('EVAL_KEEP_RUNS', output.keepRuns ?? 20),
      resultsName: envStr('EVAL_RESULTS_NAME', output.resultsName || 'result.jsonl'),
      compareFormat: envStr('EVAL_COMPARE_FORMAT', output.compareFormat || 'html')
    }
  }

  // Gates: start from file, apply EVAL_GATES override string, ensure all keys present.
  for (const key of METRIC_KEYS) {
    cfg.gates[key] = key in gatesFile ? gatesFile[key] : GATED_KEYS.includes(key) ? 0 : null
  }
  if (process.env.EVAL_GATES) {
    Object.assign(cfg.gates, parseGateOverrides(process.env.EVAL_GATES))
  }
  if (overrides?.gates) Object.assign(cfg.gates, overrides.gates)

  // Programmatic overrides (used by tests / embedders) win last.
  if (overrides) {
    if (overrides.k !== undefined) cfg.k = overrides.k
    if (overrides.capire_version !== undefined) cfg.capire_version = overrides.capire_version
    if (overrides.paths) Object.assign(cfg.paths, overrides.paths)
    if (overrides.output) Object.assign(cfg.output, overrides.output)
  }

  validateConfig(cfg)
  return cfg
}

function validateConfig(cfg) {
  if (!Number.isInteger(cfg.k) || cfg.k <= 0) throw new Error(`config: k must be a positive integer (got ${cfg.k})`)
  if (!['html', 'md'].includes(cfg.output.compareFormat)) {
    throw new Error(`config: compareFormat must be "html" or "md" (got ${cfg.output.compareFormat})`)
  }
  for (const key of GATED_KEYS) {
    const g = cfg.gates[key]
    if (g !== null && (typeof g !== 'number' || g < 0 || g > 1)) {
      throw new Error(`config: gate ${key} must be null or a number in [0,1] (got ${g})`)
    }
  }
}
