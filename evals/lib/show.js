import path from 'path'
import { loadConfig } from './config.js'
import { loadIndex } from './retriever.js'
import { renderConsoleWithBaseline } from './runner.js'
import { readRuns, sortByRunId, resultsPath } from './store.js'

// Re-render a stored run to the console — no retrieval, no scoring.
// target: undefined → newest run; a run_id → that specific run.
export async function show({ configPath, overrides, target, logger = console } = {}) {
  const cfg = await loadConfig({ configPath, overrides })
  const runs = sortByRunId(await readRuns(cfg))

  if (runs.length === 0) {
    logger.error(`No runs found in ${path.relative(process.cwd(), resultsPath(cfg))}. Run the eval first.`)
    return { code: 3 }
  }

  let report
  if (target) {
    report = runs.find(r => r.run_id === target)
    if (!report) {
      logger.error(`No run with run_id "${target}" in ${path.relative(process.cwd(), resultsPath(cfg))}.`)
      logger.error(`Available run_ids:\n  ${runs.map(r => r.run_id).join('\n  ')}`)
      return { code: 3 }
    }
  } else {
    report = runs[runs.length - 1]
  }

  // Header shows the chunk count, which the report doesn't store — read the
  // current index (cheap JSON parse, no ONNX). '?' if unavailable.
  let chunkCount = '?'
  try {
    chunkCount = (await loadIndex()).count
  } catch {
    // index cache absent — header shows '?'
  }

  // Weakest-questions annotation needs the baseline this run was diffed against.
  const baseline = report.baseline_run_id ? runs.find(r => r.run_id === report.baseline_run_id) || null : null

  logger.log(renderConsoleWithBaseline(report, report.run_id, { chunkCount }, baseline))
  return { code: 0, report }
}
