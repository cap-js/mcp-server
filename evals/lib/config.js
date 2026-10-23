import { fileURLToPath } from 'url'
import path from 'path'

// evals/ root (this file lives in evals/lib/)
const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── Run configuration --
export const CONFIG = {
  // how many results should search_docs return
  k: 5,
  // human-readable label for this run (shown in compare output)
  label: null,
  baselineRunId: null,
  // root directory that contains all embedding subdirectories to evaluate
  embeddingsDir: path.join(EVALS_DIR, '../embeddings'),
  goldenSet: path.join(EVALS_DIR, 'data/golden-set.json'),
  gates: {
    recall_at_k: 0.8,
    mrr: 0.5,
    hit_rate_at_k: 0.8,
    ndcg_at_k: null
  },
  output: {
    runsDir: path.join(EVALS_DIR, 'runs'),
    keepRuns: 500,
    resultsName: 'result.jsonl',
    compareFormat: 'html'
  }
}

export const METRIC_KEYS = ['recall_at_k', 'mrr', 'hit_rate_at_k', 'ndcg_at_k']
export const METRIC_LABEL = {
  recall_at_k: 'Recall',
  mrr: 'MRR',
  hit_rate_at_k: 'Hit-Rate',
  ndcg_at_k: 'nDCG'
}
