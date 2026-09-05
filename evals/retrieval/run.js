#!/usr/bin/env node
// Level-A retrieval eval runner.
//
//   npm run eval:retrieval            # full golden set
//   node evals/retrieval/run.js --k 1,3,5,10 --limit 20
//
// Exercises the REAL retrieval path: embeds each query with the same local
// model the server uses, ranks all chunks by cosine similarity, and scores
// against the golden set. Writes evals/retrieval/results/latest.json.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { loadChunks, searchEmbeddings } from '../../lib/embeddings.js'
import { recallAtK, reciprocalRank, ndcgAtK, pollutionAtK, percentile, mean } from './lib.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KS = (process.argv.find(a => a.startsWith('--k='))?.split('=')[1] || '1,3,5,10')
  .split(',')
  .map(Number)
const LIMIT = Number(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || Infinity)

async function loadGolden() {
  const raw = await fs.readFile(path.join(__dirname, 'golden.jsonl'), 'utf-8')
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//'))
    .map(l => JSON.parse(l))
    .slice(0, LIMIT)
}

async function main() {
  /* eslint-disable no-console */
  const golden = await loadGolden()
  const chunks = await loadChunks('code-chunks')
  console.log(`Loaded ${chunks.length} chunks, evaluating ${golden.length} queries…\n`)

  const perItem = []
  const latencies = []

  for (const item of golden) {
    const expected = Array.isArray(item.relevant) ? item.relevant : [item.relevant]
    const t0 = performance.now()
    const ranked = await searchEmbeddings(item.query, chunks)
    latencies.push(performance.now() - t0)

    const rec = {}
    for (const k of KS) rec[`recall@${k}`] = recallAtK(ranked, expected, k)
    perItem.push({
      id: item.id,
      category: item.category,
      difficulty: item.difficulty,
      ...rec,
      mrr: reciprocalRank(ranked, expected),
      ndcg: ndcgAtK(ranked, expected, 10),
      pollution: pollutionAtK(ranked, 5),
      topSource: ranked[0] ? (ranked[0].content.match(/Source:\s*(\S+)/)?.[1] ?? '?') : '?'
    })
  }

  const agg = { n: perItem.length }
  for (const k of KS) agg[`recall@${k}`] = mean(perItem.map(r => r[`recall@${k}`]))
  agg.mrr = mean(perItem.map(r => r.mrr))
  agg.ndcg = mean(perItem.map(r => r.ndcg))
  agg.pollution = mean(perItem.map(r => r.pollution))
  const sortedLat = [...latencies].sort((a, b) => a - b)
  agg.latency_p50_ms = Math.round(percentile(sortedLat, 50))
  agg.latency_p95_ms = Math.round(percentile(sortedLat, 95))

  // Report
  /* eslint-disable no-console */
  console.log('=== Aggregate ===')
  for (const [key, val] of Object.entries(agg)) {
    console.log(`  ${key.padEnd(16)} ${typeof val === 'number' && !Number.isInteger(val) ? val.toFixed(3) : val}`)
  }

  const misses = perItem.filter(r => !r[`recall@${KS[KS.length - 1]}`])
  if (misses.length) {
    console.log(`\n=== Misses (not found in top ${KS[KS.length - 1]}) ===`)
    for (const m of misses) console.log(`  ${m.id} [${m.category}] -> top: ${m.topSource}`)
  }

  // By category
  const cats = [...new Set(perItem.map(r => r.category).filter(Boolean))]
  if (cats.length > 1) {
    console.log('\n=== Recall@5 by category ===')
    for (const c of cats) {
      const rows = perItem.filter(r => r.category === c)
      console.log(`  ${c.padEnd(20)} ${mean(rows.map(r => r['recall@5'] ?? 0)).toFixed(3)} (n=${rows.length})`)
    }
  }

  const outDir = path.join(__dirname, 'results')
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(path.join(outDir, 'latest.json'), JSON.stringify({ agg, perItem }, null, 2))
  console.log(`\nWrote ${path.relative(process.cwd(), path.join(outDir, 'latest.json'))}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
