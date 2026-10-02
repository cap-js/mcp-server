/* eslint-disable no-console */
import path from 'path'
import { fileURLToPath } from 'url'
import { loadConfig } from './config.js'
import { preflight, validateGolden, buildReport, makeRunId } from './report.js'
import { appendRun, readRuns, baselineRun } from './store.js'
import { createSourceDb } from './createSourceDb/createSourceDb.js'
import { readJsonOrNull, makeSearchDocsRunner, retrieveAll, readCapireVersion, findEmbeddingDirs } from './retrieval.js'

// `deps` is a test seam: pass { makeRetriever } to score against a
// fixture without loading the ONNX model. Production omits it.
export async function evaluate({ sourceDb, golden, configPath, overrides, label = '', capire_version = 'unknown', deps = {} } = {}) {
  const cfg = await loadConfig({ configPath, overrides })
  const makeRetrieverFn = deps.makeRetriever || makeSearchDocsRunner

  const baseline = baselineRun(await readRuns(cfg), cfg.baselineRunId)
  if (cfg.baselineRunId && !baseline) {
    console.error(`(note: pinned baseline "${cfg.baselineRunId}" not found in result.jsonl — this run has no baseline)`)
  }

  const retrieve = await makeRetrieverFn(cfg.k, sourceDb)
  const perQuestionRaw = await retrieveAll(golden, retrieve)

  const config = { capire_version, golden_set: golden.golden_set, golden_set_size: golden.questions.length, k: cfg.k, label }
  const report = buildReport({ config, perQuestionRaw, baseline, gates: cfg.gates })
  const run_id = makeRunId()
  const full = { run_id, ...report }

  const { path: resultsFile, total } = await appendRun(cfg, full)
  const status = report.overall_status === 'fail' ? `FAIL (${report.gated_failures.join(', ')})` : 'PASS'
  console.error(`${status} — appended run ${run_id} → ${path.relative(process.cwd(), resultsFile)}; ${total} run(s) on file`)

  return { code: report.overall_status === 'fail' ? 1 : 0, report: full, resultsFile, perQuestionRaw }
}

// Entry point for `npm run evals`: sweep all embedding subdirs under
// cfg.embeddingsDir, then build the comparison report.
// `deps.sourceDb` is a test seam: pass a fake sourceDb to skip the ONNX model load.
export async function evaluateAndCompare({ configPath, overrides, logger = console, deps = {} } = {}) {
  const cfg = await loadConfig({ configPath, overrides })

  const golden = await readJsonOrNull(cfg.goldenSet)
  if (!golden || !Array.isArray(golden.questions)) {
    logger.error(`Golden set missing or malformed at ${cfg.goldenSet}`)
    return { code: 3 }
  }
  const problems = validateGolden(golden.questions)
  if (problems.length > 0) {
    logger.error(`Golden set at ${cfg.goldenSet} has ${problems.length} problem(s): ${JSON.stringify(problems)}`)
    return { code: 3 }
  }

  const sourceDb = deps.sourceDb ?? await createSourceDb()

  const stale = await preflight(golden.questions, sourceDb)
  if (stale.length > 0) {
    throw new Error(`${stale.length} golden doc id(s) not in the source db: ${JSON.stringify(stale)}`)
  }

  let code
  if (cfg.embeddingsDir) {
    const dirs = await findEmbeddingDirs(cfg.embeddingsDir)
    if (!dirs.length) throw new Error(`No embedding dirs found under ${cfg.embeddingsDir}`)
    console.error(`Sweep: found ${dirs.length} embedding dir(s) under ${cfg.embeddingsDir}`)
    let worstCode = 0
    for (const dir of dirs) {
      process.env.LOCAL_EMBEDDINGS_DIR = dir
      const label = [cfg.label, ...path.relative(cfg.embeddingsDir, dir).split(path.sep)].filter(Boolean).join('/')
      console.error(`\n→ ${label}`)
      const capire_version = await readCapireVersion(dir)
      const { code: c } = await evaluate({ sourceDb, golden, configPath, overrides, label, capire_version, deps })
      if (c > worstCode) worstCode = c
    }
    code = worstCode
  }

  try {
    const { compare } = await import('./compare.js')
    await compare({ configPath, overrides })
  } catch (err) {
    console.error(`(compare step failed: ${err.message})`)
  }

  return { code }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  evaluateAndCompare()
  .then(r => process.exit(r.code))
  .catch(e => {
    console.error(e)
    process.exit(3)
  })
}
