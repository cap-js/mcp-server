import path from 'path'
import fs from 'fs/promises'
import { loadConfig, METRIC_KEYS } from './config.js'
import { loadIndex, makeDefaultRetriever } from './retriever.js'
import { preflight, buildReport, makeRunId, renderConsoleWithBaseline } from './runner.js'
import { appendRun, readRuns, baselineRun } from './store.js'

async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// `deps` is an injection seam for tests: pass { loadIndex, makeRetriever } to
// score against a fixture index + retriever without loading the ONNX model.
// Production callers omit it and get the real search_docs path.
export async function run({ configPath, overrides, logger = console, deps = {} } = {}) {
  const loadIndexFn = deps.loadIndex || loadIndex
  const makeRetrieverFn = deps.makeRetriever || makeDefaultRetriever

  const cfg = await loadConfig({ configPath, overrides })

  // The eval always runs the retriever offline: it scores against the already-
  // downloaded chunk embeddings + model, and never re-fetches the corpus during
  // a run (that would break determinism). Set before the retriever loads.
  process.env.CDS_MCP_OFFLINE = 'true'

  const golden = await readJsonOrNull(cfg.paths.goldenSet)
  if (!golden || !Array.isArray(golden.questions)) {
    logger.error(`Golden set missing or malformed at ${cfg.paths.goldenSet}`)
    return { code: 3 }
  }
  // Baseline = the oldest run already on file (before this run is appended).
  // The very first run has no baseline (it becomes the reference itself).
  const baseline = baselineRun(await readRuns(cfg))

  const index = await loadIndexFn()

  // Pre-flight: fail loudly on stale relevant_doc_ids.
  const stale = preflight(golden.questions, index.idSet)
  if (stale.length > 0) {
    logger.error('PRE-FLIGHT FAILED: golden set references doc ids missing from the current index.')
    logger.error('The corpus likely re-indexed and these labels are stale — refresh the golden set (see docs/README.md).')
    for (const s of stale) logger.error(`  ${s.question}: ${s.doc_id}`)
    return { code: 2, stale }
  }

  const retrieve = await makeRetrieverFn(cfg.k)
  const perQuestionRaw = []
  for (const q of golden.questions) {
    const retrieved_ids = await retrieve(q.question)
    perQuestionRaw.push({
      id: q.id,
      question: q.question,
      relevant_doc_ids: q.relevant_doc_ids,
      retrieved_ids
    })
  }

  const config = {
    capire_version: cfg.capire_version,
    golden_set: golden.golden_set,
    golden_set_size: golden.questions.length,
    k: cfg.k
  }

  const report = buildReport({ config, perQuestionRaw, baseline, gates: cfg.gates })
  const run_id = makeRunId()
  const full = { run_id, ...report }

  const indexInfo = { chunkCount: index.count }
  const { path: resultsFile, total } = await appendRun(cfg, full)

  logger.log(renderConsoleWithBaseline(full, run_id, indexInfo, baseline))
  logger.error(`\n(appended run ${run_id} → ${path.relative(process.cwd(), resultsFile)}; ${total} run(s) on file)`)

  return { code: report.overall_status === 'fail' ? 1 : 0, report: full, resultsFile }
}

// Entry point for `npm run evals`: run the eval `config.runs` times (each run is
// appended to result.jsonl), then always build the comparison report once at the
// end. Returns the worst exit code across the runs (so a gated failure or a
// pre-flight abort still surfaces even after later runs / the compare step).
export async function runAll({ configPath, overrides, logger = console, deps = {} } = {}) {
  const cfg = await loadConfig({ configPath, overrides })
  const n = cfg.runs
  let worst = 0
  for (let i = 0; i < n; i++) {
    if (n > 1) logger.error(`\n--- run ${i + 1} of ${n} ---`)
    const { code } = await run({ configPath, overrides, logger, deps })
    worst = Math.max(worst, code)
    // Stop the loop on a hard error (missing golden set / stale ids); a gated
    // failure (code 1) is a real result — keep going so all N runs are recorded.
    if (code >= 2) break
  }

  // Always compare afterwards (best-effort; a compare failure doesn't override
  // the eval's own exit code).
  try {
    const { compare } = await import('./compare.js')
    await compare({ configPath, overrides, logger })
  } catch (err) {
    logger.error(`(compare step failed: ${err.message})`)
  }

  return { code: worst, runs: n }
}
