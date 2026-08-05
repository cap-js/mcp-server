import path from 'path'
import fs from 'fs/promises'
import { loadConfig } from './config.js'
import { loadIndex, makeDefaultRetriever } from './retriever.js'
import { preflight, validateGolden, buildReport, makeRunId, renderConsoleWithBaseline } from './runner.js'
import { appendRun, readRuns, baselineRun } from './store.js'

async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// `deps` is a test seam: pass { loadIndex, makeRetriever } to score against a
// fixture without loading the ONNX model. Production omits it.
export async function run({ configPath, overrides, logger = console, deps = {} } = {}) {
  const loadIndexFn = deps.loadIndex || loadIndex
  const makeRetrieverFn = deps.makeRetriever || makeDefaultRetriever

  const cfg = await loadConfig({ configPath, overrides })

  const golden = await readJsonOrNull(cfg.paths.goldenSet)
  if (!golden || !Array.isArray(golden.questions)) {
    logger.error(`Golden set missing or malformed at ${cfg.paths.goldenSet}`)
    return { code: 3 }
  }
  const problems = validateGolden(golden.questions)
  if (problems.length > 0) {
    logger.error(`Golden set at ${cfg.paths.goldenSet} has ${problems.length} problem(s):`)
    for (const p of problems) logger.error(`  ${p}`)
    return { code: 3 }
  }
  // Baseline (read before this run is appended): pinned run if set, else oldest.
  const baseline = baselineRun(await readRuns(cfg), cfg.baselineRunId)
  if (cfg.baselineRunId && !baseline) {
    logger.error(`(note: pinned baseline "${cfg.baselineRunId}" not found in result.jsonl — this run has no baseline)`)
  }

  const index = await loadIndexFn()

  // Fail loudly on stale relevant_doc_ids (corpus likely re-indexed).
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
    k: cfg.k,
    label: cfg.label
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

// Entry point for `npm run evals`: run the eval `config.runs` times (each
// appended), then always build the comparison report. Returns the worst exit
// code across runs so a failure still surfaces.
export async function runAll({ configPath, overrides, logger = console, deps = {} } = {}) {
  const cfg = await loadConfig({ configPath, overrides })
  const n = cfg.runs
  let worst = 0
  for (let i = 0; i < n; i++) {
    if (n > 1) logger.error(`\n--- run ${i + 1} of ${n} ---`)
    const { code } = await run({ configPath, overrides, logger, deps })
    worst = Math.max(worst, code)
    // Stop on a hard error (code ≥ 2); a gated failure (1) is a real result, so
    // keep going and record all N runs.
    if (code >= 2) break
  }

  // Always compare afterwards; best-effort, doesn't override the eval exit code.
  try {
    const { compare } = await import('./compare.js')
    await compare({ configPath, overrides, logger })
  } catch (err) {
    logger.error(`(compare step failed: ${err.message})`)
  }

  return { code: worst, runs: n }
}
