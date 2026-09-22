import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs/promises'

// ── Run configuration --
export const DEFAULT_CONFIG = {
  // how many results should search_docs return
  k: 5,
  // human-readable label for this run (shown in compare output)
  label: "w-h-r-overRet5-xenMiniL12",
  // root directory that contains all embedding subdirectories to evaluate
  embeddingsDir: '../All Embeddings',
  gates: {
    recall_at_k: 0.8,
    mrr: 0.5,
    hit_rate_at_k: 0.8,
    ndcg_at_k: null
  },
  output: {
    runsDir: 'runs',
    keepRuns: 600,
    resultsName: 'result.jsonl',
    compareFormat: 'html'
  }
}

// evals/ root (this file lives in evals/lib/)
export const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const METRIC_KEYS = ['recall_at_k', 'mrr', 'hit_rate_at_k', 'ndcg_at_k']
export const GATED_KEYS = ['recall_at_k', 'mrr', 'hit_rate_at_k']
export const METRIC_LABEL = {
  recall_at_k: 'Recall',
  mrr: 'MRR',
  hit_rate_at_k: 'Hit-Rate',
  ndcg_at_k: 'nDCG'
}

function envStr(name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

// Load and resolve the effective configuration.
// Default values come from DEFAULT_CONFIG above. An external JSON file at
// configPath (used by tests) overrides them. Env vars and programmatic
// overrides win last.
export async function loadConfig({ configPath, overrides } = {}) {
  let file = DEFAULT_CONFIG

  if (configPath) {
    try {
      file = JSON.parse(await fs.readFile(path.resolve(configPath), 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  const gatesFile = { ...(file.gates || {}) }
  delete gatesFile.$comment
  const output = file.output || {}

  const resolve = p => (path.isAbsolute(p) ? p : path.join(EVALS_DIR, p))

  const cfg = {
    k: file.k ?? 5,
    label: file.label ?? null,
    baselineRunId: null,
    embeddingsDir: file.embeddingsDir ? resolve(file.embeddingsDir) : null,
    goldenSet: resolve(file.goldenSet ?? 'data/golden-set.json'),
    gates: {},
    output: {
      runsDir: resolve(envStr('EVAL_RUNS_DIR', output.runsDir || 'runs')),
      keepRuns: output.keepRuns ?? 100,
      resultsName: output.resultsName || 'result.jsonl',
      compareFormat: output.compareFormat || 'html'
    }
  }

  for (const key of METRIC_KEYS) {
    cfg.gates[key] = key in gatesFile ? gatesFile[key] : GATED_KEYS.includes(key) ? 0 : null
  }

  if (overrides) {
    if (overrides.k !== undefined) cfg.k = overrides.k
    if (overrides.label !== undefined) cfg.label = overrides.label
    if (overrides.baselineRunId !== undefined) cfg.baselineRunId = overrides.baselineRunId
    if (overrides.embeddingsDir !== undefined) cfg.embeddingsDir = overrides.embeddingsDir ? resolve(overrides.embeddingsDir) : null
    if (overrides.goldenSet !== undefined) cfg.goldenSet = resolve(overrides.goldenSet)
    if (overrides.gates) Object.assign(cfg.gates, overrides.gates)
    if (overrides.output) Object.assign(cfg.output, overrides.output)
  }

  validateConfig(cfg)
  return cfg
}

function validateConfig(cfg) {
  if (!Number.isInteger(cfg.k) || cfg.k <= 0) throw new Error(`config: k must be a positive integer (got ${cfg.k})`)
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
