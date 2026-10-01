#!/usr/bin/env node
/**
 * Runs `npm run evals` for each reranker config entry.
 * Each entry can set model, dtype, batchSize, and overRetrieve independently.
 * Updates the label in evals/lib/config.js for each run and restores it on exit.
 *
 * Env vars used:
 *   CDS_MCP_RERANK_MODEL          – cross-encoder model id
 *   CDS_MCP_RERANK_DTYPE          – onnx dtype (e.g. fp32, q8); omit for default quantized
 *   CDS_MCP_RERANK_BATCH_SIZE     – candidates per inference batch (default 10)
 *   CDS_MCP_RERANK_OVER_RETRIEVE  – fetch (k × overRetrieve) candidates before reranking (default 5)
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Per-model configs ──────────────────────────────────────────────────────────
// label     : run label written to config.js (defaults to "<model> (<dtype>)")
// model     : CDS_MCP_RERANK_MODEL
// dtype     : CDS_MCP_RERANK_DTYPE     (omit or null → use model default)
// batchSize : CDS_MCP_RERANK_BATCH_SIZE (omit or null → 10)
// overRetrieve: CDS_MCP_RERANK_OVER_RETRIEVE (omit or null → 5)
const CONFIGS = [
  // { model: 'Xenova/ms-marco-TinyBERT-L-2-v2',      dtype: 'q4'  },
  // { model: 'Xenova/ms-marco-TinyBERT-L-2-v2',      dtype: 'q8'  },
  // { model: 'Xenova/ms-marco-TinyBERT-L-2-v2',      dtype: 'fp32' },

  // { model: 'Xenova/ms-marco-MiniLM-L-2-v2',        dtype: 'q4'  },
  // { model: 'Xenova/ms-marco-MiniLM-L-2-v2',        dtype: 'q8'  },
  // { model: 'Xenova/ms-marco-MiniLM-L-2-v2',        dtype: 'fp32' },

  // { model: 'Xenova/ms-marco-MiniLM-L-4-v2',        dtype: 'q4'  },
  // { model: 'Xenova/ms-marco-MiniLM-L-4-v2',        dtype: 'q8'  },
  // { model: 'Xenova/ms-marco-MiniLM-L-4-v2',        dtype: 'fp32' },

  { model: 'Xenova/ms-marco-MiniLM-L-6-v2' },
  { model: 'Xenova/ms-marco-MiniLM-L-6-v2',        dtype: 'q4'  },
  { model: 'Xenova/ms-marco-MiniLM-L-6-v2',        dtype: 'q8'  },
  { model: 'Xenova/ms-marco-MiniLM-L-6-v2',        dtype: 'fp32' },

  // { model: 'Xenova/ms-marco-MiniLM-L-12-v2',       dtype: 'q4'  },
  // { model: 'Xenova/ms-marco-MiniLM-L-12-v2',       dtype: 'q8'  },
  // { model: 'Xenova/ms-marco-MiniLM-L-12-v2',       dtype: 'fp32' },
  // { model: 'Xenova/bge-reranker-base',             },
  // { model: 'Xenova/bge-reranker-base',              dtype: 'q4'  },
  // { model: 'Xenova/bge-reranker-base',              dtype: 'q8'  },
  // { model: 'Xenova/bge-reranker-base',              dtype: 'fp32' },

  // { model: 'BAAI/bge-reranker-base',                dtype: 'fp32' },

  // { model: 'BAAI/bge-reranker-large',               dtype: 'fp32' },

  // { model: 'jinaai/jina-reranker-v1-tiny-en',       dtype: 'q4'  },
  // { model: 'jinaai/jina-reranker-v1-tiny-en',       dtype: 'q8'  },
  // { model: 'jinaai/jina-reranker-v1-tiny-en',       dtype: 'fp32' },

  // { model: 'mixedbread-ai/mxbai-rerank-xsmall-v1',  dtype: 'q4'  },
  // { model: 'mixedbread-ai/mxbai-rerank-xsmall-v1',  dtype: 'q8'  },
  // { model: 'mixedbread-ai/mxbai-rerank-xsmall-v1',  dtype: 'fp32' },

  // { model: 'mixedbread-ai/mxbai-rerank-base-v1',    dtype: 'q4'  },
  // { model: 'mixedbread-ai/mxbai-rerank-base-v1',    dtype: 'q8'  },
  // { model: 'mixedbread-ai/mxbai-rerank-base-v1',    dtype: 'fp32' },
]
// ──────────────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, '..', 'evals', 'lib', 'config.js')
const LABEL_RE = /label:\s*(?:null|'[^']*'|"[^"]*")/

const originalConfig = readFileSync(CONFIG_PATH, 'utf8')

function setLabel(label) {
  writeFileSync(CONFIG_PATH, originalConfig.replace(LABEL_RE, `label: '${label}'`))
}

function restoreConfig() {
  writeFileSync(CONFIG_PATH, originalConfig)
}

process.on('exit', restoreConfig)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

const results = []

for (const cfg of CONFIGS) {
  const { model, dtype, batchSize, overRetrieve } = cfg
  const label = cfg.label ?? `${model} (${dtype ?? 'default'})`

  const bar = '='.repeat(60)
  const detail = [
    dtype        && `dtype=${dtype}`,
    batchSize    && `batchSize=${batchSize}`,
    overRetrieve && `overRetrieve=${overRetrieve}`,
  ].filter(Boolean).join('  ')

  console.log(`\n${bar}`)
  console.log(`Reranker: ${model}${detail ? `  [${detail}]` : ''}`)
  console.log(bar)

  setLabel(label)

  const env = { ...process.env, CDS_MCP_RERANK_MODEL: model, RERANK_ENABLED: true }
  if (dtype        != null) env.CDS_MCP_RERANK_DTYPE         = dtype
  if (batchSize    != null) env.CDS_MCP_RERANK_BATCH_SIZE     = String(batchSize)
  if (overRetrieve != null) env.CDS_MCP_RERANK_OVER_RETRIEVE  = String(overRetrieve)

  const { status } = spawnSync('npm', ['run', 'evals'], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'inherit',
    shell: false,
  })

  results.push({ label, ok: status === 0 })
}

restoreConfig()

const passed = results.filter(r => r.ok)
const failed = results.filter(r => !r.ok)

console.log(`\n${'='.repeat(60)}`)
console.log(`Sweep done — ${passed.length}/${results.length} passed`)
if (failed.length) {
  console.log('Failed:')
  failed.forEach(r => console.log(`  - ${r.label}`))
}

process.exit(failed.length ? 1 : 0)
