#!/usr/bin/env node

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
      --model <name>         Embedding model (e.g. org/model); default: sentence-transformers/all-MiniLM-L6-v2

Environment variables:
  CDS_MCP_OFFLINE=true       Same as --offline
  CDS_MCP_MODEL=<name>       Same as --model

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
if (values.model) process.env.CDS_MCP_MODEL = values.model

const { default: run, runTool } = await import('./lib/run.js')
const { downloadEmbeddings } = await import('./lib/searchMarkdownDocs.js')

if (values.download || values['download-embeddings']) {
  const otherFlags = Object.entries(values).filter(([k, v]) => v && k !== 'model' && k !== 'download' && k !== 'download-embeddings')
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
