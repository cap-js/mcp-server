/* eslint-disable no-console */
import path from 'path'
import fs from 'fs/promises'
import { CONFIG } from '../config.js'
import { readRuns, sortByRunId } from '../store.js'
import { renderHtml } from './html.js'
import { renderMarkdownCompare } from './md.js'

async function collectRuns(cfg) {
  return sortByRunId(await readRuns(cfg))
}

export async function compare({ config } = {}) {
  const cfg = {
    ...CONFIG,
    ...config,
    gates: { ...CONFIG.gates, ...config?.gates },
    output: { ...CONFIG.output, ...config?.output }
  }
  const runs = await collectRuns(cfg)

  if (runs.length === 0) {
    console.error(
      `No runs found under ${path.relative(process.cwd(), cfg.output.runsDir)}. Run the eval first.`
    )
    return { code: 3 }
  }

  const fmt = cfg.output.compareFormat // 'html' | 'md' (validated in config)
  let content
  if (fmt === 'md') {
    content = renderMarkdownCompare(runs)
  } else {
    content = renderHtml(runs)
  }
  const out = path.join(cfg.output.runsDir, `compare.${fmt}`)
  await fs.writeFile(out, content)

  const rel = path.relative(process.cwd(), out)
  console.log(`Compared ${runs.length} run(s) → ${rel}`)
  if (fmt === 'html') {
    const opener =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    console.log(`Open it in your browser:  ${opener} ${rel}`)
    console.log(`  or paste this into the address bar:  file://${out}`)
  } else {
    console.log(`Open it in your editor/viewer:  ${rel}`)
  }
  return { code: 0, runs: runs.length, outPath: out, format: fmt }
}
