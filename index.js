#!/usr/bin/env node

import { emitWarning } from 'node:process'
process.emitWarning = (warning, ...args) => {
  if (typeof warning === 'string' && warning.includes('SQLite is an experimental feature')) return
  emitWarning(warning, ...args)
}

import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/* eslint-disable no-console */
const helpText = `Usage: cds-mcp [options] [tool] [args...]

Options:
  -h, --help                 Show this help message
  -v, --version              Show version number
      --download             Download latest embeddings and model files
      --offline              Skip downloading of embeddings updates
      --model <name>         Embedding model (e.g. org/model); default: BAAI/bge-small-en-v1.5

Environment variables:
  CDS_MCP_OFFLINE=true           Same as --offline
  CDS_MCP_MODEL=<name>           Same as --model
  CDS_MCP_MANIFEST_TIMEOUT       Manifest request timeout in milliseconds (default: 15000)
  CDS_MCP_DOWNLOAD_TIMEOUT       Bundle response-header timeout in milliseconds (default: 30000)
  CDS_MCP_GENERIC_EMBEDDINGS=true  Search all runtimes (skip the detected-runtime filter)
  CDS_MCP_MAX_RESULTS            Upper limit on search_docs results (positive integer)
  CDS_MCP_RERANK_ENABLED=true    Rerank search_docs results with a local cross-encoder (default: false)
  CDS_MCP_RERANK_MODEL=<name>    Cross-encoder model for reranking (default: Xenova/ms-marco-MiniLM-L-6-v2)
  CDS_MCP_RERANK_DTYPE=<type>    Data type for the reranking model (default: q8; use fp32 if no model_quantized.onnx)
  CDS_MCP_RERANK_EXTERNAL_DATA   Set true for reranking models with external .onnx_data weight files
  CDS_MCP_RERANK_BATCH_SIZE      Results per reranking batch (positive integer, default: 1)

Tools:
  search_model <projectPath> [name] [kind] [topN] [namesOnly]
  search_docs <query> [maxResults]`

let values, positionals
try {
  ;({ values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      'download-embeddings': { type: 'boolean' },
      download: { type: 'boolean' },
      offline: { type: 'boolean' },
      model: { type: 'string' }
    },
    allowPositionals: true,
    strict: true
  }))
} catch {
  console.error(helpText)
  process.exit(1)
}

// Set model BEFORE any import that triggers embeddings download side-effects.
if (values.model !== undefined) process.env.CDS_MCP_MODEL = values.model

const { default: run, runTool } = await import('./lib/run.js')
const { downloadEmbeddings } = await import('./lib/searchMarkdownDocs.js')

if (values.download || values['download-embeddings']) {
  const otherFlags = Object.entries(values).filter(
    ([k, v]) => v && k !== 'model' && k !== 'download' && k !== 'download-embeddings'
  )
  if (otherFlags.length > 0 || positionals.length > 0) {
    console.error('--download must be the only argument (aside from --model)')
    process.exit(1)
  }
  const result = await downloadEmbeddings()
  console.log(JSON.stringify(result))
} else if (values.help) {
  console.log(helpText)
} else if (values.version) {
  const pkg = JSON.parse(await readFile(join(__dirname, 'package.json'), 'utf-8'))
  console.log(pkg.version)
} else if (positionals.length > 0) {
  const [toolName, ...toolArgs] = positionals
  runTool(toolName, ...toolArgs)
} else {
  run()
}
