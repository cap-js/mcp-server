#!/usr/bin/env node
/* eslint-disable no-console */
// Re-embed all corpora in embeddings_history with the active model.
// Usage: CDS_MCP_MODEL=perplexity-ai/pplx-embed-context-v1-0.6b \
//   node evals/bin/embed-history.js \
//     <source-history-dir> <output-history-dir>
//
// Copies each <source>/<corpus>/code-chunks.json to <output>/<corpus>/ and
// regenerates code-chunks.bin using the active model.
// Never modifies the source directory.

process.env.CDS_MCP_OFFLINE = 'true'

import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'

const [,, srcDir, outDir] = process.argv
if (!srcDir || !outDir) {
  console.error('Usage: CDS_MCP_MODEL=<model> node evals/bin/embed-history.js <src-dir> <out-dir>')
  process.exit(1)
}

const { createEmbeddings } = await import('../../lib/embeddings.js')
const calculateEmbeddings = (await import('../../lib/calculateEmbeddings.js')).default

const model = process.env.CDS_MCP_MODEL || 'Xenova/all-MiniLM-L6-v2'
const probe = await calculateEmbeddings('probe')
console.log(`Model: ${model}  dim: ${probe.length}`)

const corpora = (await fs.readdir(srcDir, { withFileTypes: true }))
  .filter(e => e.isDirectory())
  .map(e => e.name)
  .sort()

console.log(`\nFound ${corpora.length} corpora in ${srcDir}\n`)

for (const corpus of corpora) {
  const srcJson = path.join(srcDir, corpus, 'code-chunks.json')
  const destDir = path.join(outDir, corpus)

  const meta = JSON.parse(await fs.readFile(srcJson, 'utf8'))
  const { chunks } = meta
  const srcDim = meta.dim

  console.log(`${corpus}: ${chunks.length} chunks (src dim=${srcDim}) → embedding at dim=${probe.length} ...`)
  await fs.mkdir(destDir, { recursive: true })
  await fs.copyFile(srcJson, path.join(destDir, 'code-chunks.json'))

  const t0 = Date.now()
  await createEmbeddings('code-chunks', chunks, destDir)
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`  done in ${secs}s → ${destDir}`)
}

console.log('\nAll done.')
