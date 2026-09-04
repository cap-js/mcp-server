import path from 'path'
import fs from 'fs/promises'

// The append-only results file: one JSON run report per line (JSONL).
export function resultsPath(cfg) {
  return path.join(cfg.paths.runsDir, cfg.output.resultsName)
}

// All run reports (write order). Skips blank/corrupt lines; [] if no file.
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
    let parsed
    try {
      parsed = JSON.parse(t)
    } catch {
      continue // skip a corrupt line rather than fail the whole read
    }
    // Skip structurally-valid JSON that isn't a run report, so downstream code
    // reading r.aggregate[...].value can't crash on a wrong-shape line.
    if (!parsed || typeof parsed !== 'object' || typeof parsed.run_id !== 'string' || typeof parsed.aggregate !== 'object' || parsed.aggregate === null) {
      continue
    }
    runs.push(parsed)
  }
  return runs
}

// run_id is an ISO-timestamp prefix, so string sort is chronological.
export function sortByRunId(runs) {
  return [...runs].sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0))
}

// The baseline this run is compared against:
//   - pinnedId set → that specific run (null if it's not on file — never a
//     silent substitute), a stable anchor that doesn't move as runs are pruned.
//   - otherwise → the oldest run on file (slides forward as runs are pruned).
// null when there are no runs.
export function baselineRun(runs, pinnedId) {
  const sorted = sortByRunId(runs)
  if (pinnedId) return sorted.find(r => r.run_id === pinnedId) || null
  return sorted.length ? sorted[0] : null
}

// Append one run, then cap the file to the most recent `keep` runs (keep < 0 =
// keep all). Rewrites the whole file so the cap is enforced deterministically.
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

