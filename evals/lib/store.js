import path from 'path'
import fs from 'fs/promises'

// The single append-only results file: one JSON run report per line (JSONL).
export function resultsPath(cfg) {
  return path.join(cfg.paths.runsDir, cfg.output.resultsName)
}

// Read all run reports from result.jsonl (oldest → newest write order).
// Skips blank/corrupt lines. Returns [] if the file doesn't exist.
export async function readRuns(cfg) {
  let text
  try {
    text = await fs.readFile(resultsPath(cfg), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const runs = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      runs.push(JSON.parse(t))
    } catch {
      /* skip a corrupt line rather than fail the whole read */
    }
  }
  return runs
}

// Runs sorted chronologically by run_id (ISO-timestamp prefix sorts correctly).
export function sortByRunId(runs) {
  return [...runs].sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0))
}

// The baseline is the OLDEST run currently on file (by run_id). Deltas, the gate
// diagnosis, and the weakest-questions annotation are computed against it.
// Returns null when there are no runs (the oldest run has no baseline — it IS
// the reference). Note: result.jsonl is capped to keepRuns, so the "oldest"
// slides forward as old runs are pruned — the reference point is not pinned.
export function baselineRun(runs) {
  const sorted = sortByRunId(runs)
  return sorted.length ? sorted[0] : null
}

// Append one run, then cap the file to the most recent `keep` runs (by run_id).
// keep < 0 => keep all. Rewrites the file so the cap is enforced deterministically.
export async function appendRun(cfg, report) {
  await fs.mkdir(cfg.paths.runsDir, { recursive: true })
  const runs = await readRuns(cfg)
  runs.push(report)
  let kept = sortByRunId(runs)
  const keep = cfg.output.keepRuns
  if (keep >= 0 && kept.length > keep) {
    kept = kept.slice(kept.length - keep)
  }
  const body = kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : '')
  await fs.writeFile(resultsPath(cfg), body)
  return { path: resultsPath(cfg), total: kept.length }
}

