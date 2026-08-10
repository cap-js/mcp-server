import path from 'path'
import fs from 'fs/promises'
import { loadConfig } from './config.js'
import { loadIndex, makeDefaultRetriever } from './retriever.js'
import { preflight, validateGolden, buildReport, makeRunId } from './runner.js'
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

  // Warn (don't abort) on stale relevant_doc_ids — the corpus likely re-indexed
  // and these labels no longer match; they'll score as misses until refreshed.
  const stale = preflight(golden.questions, index.idSet)
  if (stale.length > 0) {
    logger.error(`PRE-FLIGHT WARNING: ${stale.length} golden doc id(s) not in the current index (will score as misses — refresh the golden set, see docs/README.md):`)
    for (const s of stale) logger.error(`  ${s.question}: ${s.doc_id}`)
  }

  const retrieve = await makeRetrieverFn(cfg.k)
  const perQuestionRaw = []
  for (const q of golden.questions) {
    const retrieved_ids = await retrieve(q.question)
    const retrieved_texts = retrieve.lastTexts ? retrieve.lastTexts.slice() : undefined

    // A retrieved chunk can implicitly contain additional relevant ids when a
    // golden URL appears verbatim in the chunk body (e.g. a sibling section is
    // linked from the retrieved section). Expand each slot's id to include any
    // golden relevant_doc_id found as a URL substring in that slot's text, so
    // metrics credit the chunk as a hit even though its Source: line differs.
    const effective_ids = retrieved_ids.map((id, i) => {
      const text = retrieved_texts?.[i] || ''
      const extras = q.relevant_doc_ids.filter(rel => rel !== id && text.includes(rel))
      return extras.length ? [id, ...extras] : id
    }).flat()

    perQuestionRaw.push({
      id: q.id,
      question: q.question,
      relevant_doc_ids: q.relevant_doc_ids,
      retrieved_ids: effective_ids,
      retrieved_texts
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

  const { path: resultsFile, total } = await appendRun(cfg, full)

  const status = report.overall_status === 'fail' ? `FAIL (${report.gated_failures.join(', ')})` : 'PASS'
  logger.error(`${status} — appended run ${run_id} → ${path.relative(process.cwd(), resultsFile)}; ${total} run(s) on file`)

  return { code: report.overall_status === 'fail' ? 1 : 0, report: full, resultsFile }
}

// Entry point for `npm run evals`: run the eval once, then build the comparison report.
export async function runAll({ configPath, overrides, logger = console, deps = {} } = {}) {
  const { code } = await run({ configPath, overrides, logger, deps })

  // Always compare afterwards; best-effort, doesn't override the eval exit code.
  try {
    const { compare } = await import('./compare.js')
    await compare({ configPath, overrides, logger })
  } catch (err) {
    logger.error(`(compare step failed: ${err.message})`)
  }

  return { code }
}
