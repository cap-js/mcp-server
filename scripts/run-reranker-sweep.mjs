#!/usr/bin/env node
/**
 * Runs `npm run evals` for each reranker model.
 * For each run, sets CDS_MCP_RERANK_MODEL and updates the label in evals/lib/config.js.
 * Restores config.js to its original state when done.
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MODELS = [
  'Xenova/ms-marco-TinyBERT-L-2-v2',
  'Xenova/ms-marco-MiniLM-L-2-v2',
  'Xenova/ms-marco-MiniLM-L-4-v2',
  'Xenova/ms-marco-MiniLM-L-6-v2',
  'Xenova/ms-marco-MiniLM-L-12-v2',
  'Xenova/bge-reranker-base',
  'BAAI/bge-reranker-base',
  'jinaai/jina-reranker-v1-tiny-en',
  'jina-reranker-v1-turbo-en',
  'mixedbread-ai/mxbai-rerank-xsmall-v1',
  'mixedbread-ai/mxbai-rerank-base-v1',
]

const CONFIG_PATH = path.join(__dirname, '..', 'evals', 'lib', 'config.js')
const LABEL_RE = /label:\s*(?:null|'[^']*'|"[^"]*")/

const originalConfig = readFileSync(CONFIG_PATH, 'utf8')

function setLabel(label) {
  const updated = originalConfig.replace(LABEL_RE, `label: '${label}'`)
  writeFileSync(CONFIG_PATH, updated)
}

function restoreConfig() {
  writeFileSync(CONFIG_PATH, originalConfig)
}

process.on('exit', restoreConfig)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

const results = []

for (const model of MODELS) {
  const bar = '='.repeat(60)
  console.log(`\n${bar}`)
  console.log(`Reranker: ${model}`)
  console.log(bar)

  setLabel(model)

  const { status } = spawnSync('npm', ['run', 'evals'], {
    cwd: __dirname,
    env: { ...process.env, CDS_MCP_RERANK_MODEL: model },
    stdio: 'inherit',
    shell: false,
  })

  results.push({ model, ok: status === 0 })
}

restoreConfig()

const passed = results.filter(r => r.ok)
const failed = results.filter(r => !r.ok)

console.log(`\n${'='.repeat(60)}`)
console.log(`Sweep done — ${passed.length}/${results.length} passed`)
if (failed.length) {
  console.log('Failed:')
  failed.forEach(r => console.log(`  - ${r.model}`))
}

process.exit(failed.length ? 1 : 0)
