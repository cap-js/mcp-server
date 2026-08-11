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

function envStr(name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

// Load and resolve the effective configuration.
// Everything lives in config.json. Two env vars are honoured for day-to-day
// runs — EVAL_LABEL (tag a run) and EVAL_RUNS_DIR (point at another corpus'
// results) — plus programmatic overrides used by tests and bin/compare.js.
export async function loadConfig({ configPath, overrides } = {}) {
  const cfgPath = configPath ? path.resolve(configPath) : path.join(EVALS_DIR, 'config.json')

  let file = {}
  try {
    file = JSON.parse(await fs.readFile(cfgPath, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    // No config.json → pure defaults.
  }

  const paths = file.paths || {}
  const gatesFile = { ...(file.gates || {}) }
  delete gatesFile.$comment
  const output = file.output || {}

  const resolve = p => (path.isAbsolute(p) ? p : path.join(EVALS_DIR, p))

  const cfg = {
    configPath: cfgPath,
    k: file.k ?? 5,
    capire_version: file.capire_version || 'unknown',
    // Optional human-readable tag to tell runs apart in reports; '' = unset.
    label: envStr('EVAL_LABEL', file.label || ''),
    // Pinned baseline run_id; empty/absent → baseline is the oldest run on file.
    baselineRunId: file.baselineRunId || null,
    paths: {
      goldenSet: resolve(paths.goldenSet || 'data/golden-set.json'),
      runsDir: resolve(envStr('EVAL_RUNS_DIR', paths.runsDir || 'runs'))
    },
    gates: {},
    output: {
      keepRuns: output.keepRuns ?? 20,
      resultsName: output.resultsName || 'result.jsonl',
      compareFormat: output.compareFormat || 'html'
    }
  }

  // Gates: file value if present, else default (0 for gated metrics, null otherwise).
  for (const key of METRIC_KEYS) {
    cfg.gates[key] = key in gatesFile ? gatesFile[key] : GATED_KEYS.includes(key) ? 0 : null
  }

  // Programmatic overrides (used by tests / bin/compare.js) win last.
  if (overrides) {
    if (overrides.k !== undefined) cfg.k = overrides.k
    if (overrides.capire_version !== undefined) cfg.capire_version = overrides.capire_version
    if (overrides.label !== undefined) cfg.label = overrides.label
    if (overrides.baselineRunId !== undefined) cfg.baselineRunId = overrides.baselineRunId
    if (overrides.gates) Object.assign(cfg.gates, overrides.gates)
    if (overrides.paths) Object.assign(cfg.paths, overrides.paths)
    if (overrides.output) Object.assign(cfg.output, overrides.output)
  }

  validateConfig(cfg)
  return cfg
}

function validateConfig(cfg) {
  if (!Number.isInteger(cfg.k) || cfg.k <= 0) throw new Error(`config: k must be a positive integer (got ${cfg.k})`)
  // keepRuns: -1 (keep all) or a positive integer; 0 would wipe the just-appended run.
  const keep = cfg.output.keepRuns
  if (keep !== -1 && (!Number.isInteger(keep) || keep <= 0)) {
    throw new Error(`config: keepRuns must be -1 (keep all) or a positive integer (got ${keep})`)
  }
  if (!['html', 'md'].includes(cfg.output.compareFormat)) {
    throw new Error(`config: compareFormat must be "html" or "md" (got ${cfg.output.compareFormat})`)
  }
  for (const key of METRIC_KEYS) {
    const g = cfg.gates[key]
    if (g !== null && (typeof g !== 'number' || Number.isNaN(g) || g < 0 || g > 1)) {
      throw new Error(`config: gate ${key} must be null or a number in [0,1] (got ${g})`)
    }
  }
}
