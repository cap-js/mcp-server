#!/usr/bin/env node
// Compares hybrid-search-only vs hybrid + rerank on the golden evaluation set.
// Usage: node scripts/benchmark-rerank.js
import fs from 'fs/promises'
import { hybridSearch, loadChunks } from '../lib/embeddings.js'
import { rerank } from '../lib/rerank.js'
import { resolveLocalVersion } from '../lib/searchMarkdownDocs.js'

const METRICS = '/Users/i543501/SAPDevelop/mcp-server/evals/lib/metrics.js'
const GOLDEN  = '/Users/i543501/SAPDevelop/mcp-server/evals/data/golden-set.json'
const K            = 5
const OVER_RETRIEVE = 10   // candidates passed to reranker = K * OVER_RETRIEVE

const { metricsFor, mean, round } = await import(METRICS)
const golden = JSON.parse(await fs.readFile(GOLDEN, 'utf8'))

const { localDir } = await resolveLocalVersion()
const chunks = await loadChunks('code-chunks', localDir)

const baselineRows = []
const rerankRows   = []
const total = golden.questions.length

for (let i = 0; i < total; i++) {
  const q = golden.questions[i]
  process.stderr.write(`\r[${i + 1}/${total}] ${q.question.substring(0, 60).padEnd(60)}`)

  const candidates = (await hybridSearch(q.question, chunks)).slice(0, K * OVER_RETRIEVE)

  const toSlots = rs => rs.map(r => ({ ids: r.meta?.source ? [r.meta.source] : [] }))

  baselineRows.push(metricsFor(q.relevant_doc_ids, toSlots(candidates.slice(0, K)), K))
  rerankRows  .push(metricsFor(q.relevant_doc_ids, toSlots(await rerank(q.question, candidates, K)), K))
}

process.stderr.write('\n')

const METRIC_KEYS   = ['recall_at_k', 'mrr', 'hit_rate_at_k', 'ndcg_at_k']
const METRIC_LABELS = ['Recall@5',    'MRR@5', 'Hit-Rate@5',  'nDCG@5']

console.log(`\n${'Metric'.padEnd(14)} ${'Hybrid'.padStart(8)} ${'+ Rerank'.padStart(9)} ${'Delta'.padStart(8)}`)
console.log('-'.repeat(42))

for (let m = 0; m < METRIC_KEYS.length; m++) {
  const key = METRIC_KEYS[m]
  const b = round(mean(baselineRows.map(r => r[key])), 4)
  const r = round(mean(rerankRows  .map(r => r[key])), 4)
  const d = round(r - b, 4)
  console.log(`${METRIC_LABELS[m].padEnd(14)} ${String(b).padStart(8)} ${String(r).padStart(9)} ${(d > 0 ? '+' : '') + d}`.padEnd(42))
}
