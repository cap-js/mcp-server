import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs/promises'

// ── Run configuration --
export const DEFAULT_CONFIG = {
  k: 5,
  capire_version: '2026.5.0',
  label: '',           // human-readable tag shown in reports
  baselineRunId: null, // pin a specific run as Δ baseline; null = oldest on file
  model: null,
  paths: {
    goldenSet: 'data/golden-set.json',
    runsDir: 'runs',
    embeddingsSweepDir: '/Users/i543501/SAPDevelop/Issue-Reproducer-Examples/cap-mcp-evals/All Embeddings'
  },
  gates: {
    recall_at_k: 0.8,
    mrr: 0.5,
    hit_rate_at_k: 0.8,
    precision_at_k: null,
    ndcg_at_k: null
  },
  output: {
    keepRuns: 600,
    resultsName: 'result.jsonl',
    compareFormat: 'html'
  }
}

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

  const paths = file.paths || {}
  const gatesFile = { ...(file.gates || {}) }
  delete gatesFile.$comment
  const output = file.output || {}

  const resolve = p => (path.isAbsolute(p) ? p : path.join(EVALS_DIR, p))

  const cfg = {
    k: file.k ?? 5,
    capire_version: file.capire_version || 'unknown',
    model: file.model || null,
    label: envStr('EVAL_LABEL', file.label || ''),
    baselineRunId: file.baselineRunId || null,
    paths: {
      goldenSet: resolve(paths.goldenSet || 'data/golden-set.json'),
      runsDir: resolve(envStr('EVAL_RUNS_DIR', paths.runsDir || 'runs')),
      embeddingsSweepDir: paths.embeddingsSweepDir ? resolve(paths.embeddingsSweepDir) : null
    },
    gates: {},
    output: {
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
    if (overrides.model !== undefined) cfg.model = overrides.model
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
