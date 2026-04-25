#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import run, { runTool } from './lib/run.js'
import { downloadEmbeddings } from './lib/searchMarkdownDocs.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/* eslint-disable no-console */
const helpText = `Usage: cds-mcp [options] [tool] [args...]

Options:
  -h, --help                 Show this help message
  -v, --version              Show version number
      --download-embeddings  Download latest documentation embeddings
      --offline              Skip downloading of embeddings updates

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
      offline: { type: 'boolean' }
    },
    allowPositionals: true,
    strict: true
  }))
} catch {
  console.error(helpText)
  process.exit(1)
}

if (values['download-embeddings']) {
  if (Object.values(values).filter(Boolean).length > 1 || positionals.length > 0) {
    console.error('--download-embeddings must be the only argument')
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
