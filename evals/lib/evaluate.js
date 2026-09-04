import path from 'path'
import fs from 'fs/promises'
import { loadConfig, EVALS_DIR } from './config.js'
import { makeSearchDocsRunner } from './search-docs.js'
import { preflight, validateGolden, buildReport, makeRunId } from './report.js'
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
export async function evaluate({ configPath, overrides, logger = console, deps = {} } = {}) {
  const cfg = await loadConfig({ configPath, overrides })

  const makeRetrieverFn = deps.makeRetriever || makeSearchDocsRunner

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

  const sourceMap = await readJsonOrNull(path.join(EVALS_DIR, 'data', 'sourceMap.json'))

  // Warn (don't abort) on stale relevant_doc_ids — the corpus likely re-indexed
  // and these labels no longer match; they'll score as misses until refreshed.
  const stale = preflight(golden.questions, sourceMap)
  if (stale.length > 0) {
    logger.error(`PRE-FLIGHT WARNING: ${stale.length} golden doc id(s) not in the current index (will score as misses — refresh the golden set, see docs/README.md):`)
    for (const s of stale) logger.error(`  ${s.question}: ${s.doc_id}`)
  }

  const retrieve = await makeRetrieverFn(cfg.k, sourceMap)
  const perQuestionRaw = []
  for (const q of golden.questions) {
    const resolvedChunk = await retrieve(q)
    perQuestionRaw.push({
      id: q.id,
      question: q.question,
      relevant_doc_ids: q.relevant_doc_ids,
      retrievedIds: resolvedChunk
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

  return { code: report.overall_status === 'fail' ? 1 : 0, report: full, resultsFile, perQuestionRaw }
}

async function findEmbeddingDirs(sweepDir) {
  const results = []
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    if (entries.some(e => e.isFile() && e.name === 'code-chunks.json')) { results.push(dir); return }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name))
    }
  }
  await walk(sweepDir)
  return results.sort()
}

// Entry point for `npm run evals`: run the eval once (or sweep all subdirs if
// embeddingsSweepDir is set), then build the comparison report.
export async function evaluateAndCompare({ configPath, overrides, logger = console, deps = {} } = {}) {
  const cfg = await loadConfig({ configPath, overrides })

  let code
  let perQuestionRaw
  if (cfg.paths.embeddingsSweepDir) {
    const dirs = await findEmbeddingDirs(cfg.paths.embeddingsSweepDir)
    if (!dirs.length) throw new Error(`No embedding dirs found under ${cfg.paths.embeddingsSweepDir}`)
    logger.error(`Sweep: found ${dirs.length} embedding dir(s) under ${cfg.paths.embeddingsSweepDir}`)
    const embeddingsDir = path.join(EVALS_DIR, '..', 'embeddings')
    const sweepBasename = path.basename(cfg.paths.embeddingsSweepDir)
    let worstCode = 0
    for (const dir of dirs) {
      const segments = path.relative(cfg.paths.embeddingsSweepDir, dir).split(path.sep)
      const label = [sweepBasename, ...segments.slice(-2)].join('/')
      logger.error(`\n→ ${label}`)
      if (!deps.makeRetriever) {
        await fs.copyFile(path.join(dir, 'code-chunks.json'), path.join(embeddingsDir, 'code-chunks.json'))
        await fs.copyFile(path.join(dir, 'code-chunks.bin'), path.join(embeddingsDir, 'code-chunks.bin'))
      }
      const { code: c } = await evaluate({ configPath, overrides: { ...overrides, label }, logger, deps })
      if (c > worstCode) worstCode = c
    }
    code = worstCode
  } else {
    ;({ code, perQuestionRaw } = await evaluate({ configPath, overrides, logger, deps }))
  }

  try {
    const { compare } = await import('./compare.js')
    await compare({ configPath, overrides, logger, perQuestionRaw })
  } catch (err) {
    logger.error(`(compare step failed: ${err.message})`)
  }

  return { code }
}
