/* eslint-disable no-console */
import path from 'path'
import { fileURLToPath } from 'url'
import { loadConfig } from './config.js'
import { preflight, validateGolden, buildReport, makeRunId } from './report.js'
import { appendRun, readRuns, baselineRun } from './store.js'
import { sourceDbRuntime } from './createSourceDb/createSourceDb.js'
import {
  readJsonOrNull,
  retrievalRuntime,
  retrieveAll,
  readCapireVersion,
  findEmbeddingDirs
} from './retrieval.js'

export async function evaluate({
  sourceDb,
  golden,
  overrides,
  label = '',
  capire_version = 'unknown'
} = {}) {
  const cfg = await loadConfig({ overrides })

  // Only compare against runs with the same evaluation dimensions (K + golden
  // set); a baseline from a different config makes deltas meaningless. A pinned
  // baselineRunId is a deliberate anchor, so it still resolves against all runs.
  const allRuns = await readRuns(cfg)
  const candidates = cfg.baselineRunId
    ? allRuns
    : allRuns.filter(
        (run) => run.config?.k === cfg.k && run.config?.golden_set === golden.golden_set
      )
  const baseline = baselineRun(candidates, cfg.baselineRunId)
  if (cfg.baselineRunId && !baseline) {
    console.error(
      `(note: pinned baseline "${cfg.baselineRunId}" not found in result.jsonl — this run has no baseline)`
    )
  }

  const retrieve = await retrievalRuntime.makeSearchDocsRunner(cfg.k, sourceDb)
  const perQuestionRaw = await retrieveAll(golden, retrieve)

  const config = {
    capire_version,
    golden_set: golden.golden_set,
    golden_set_size: golden.questions.length,
    k: cfg.k,
    label
  }
  const report = buildReport({ config, perQuestionRaw, baseline, gates: cfg.gates })
  const run_id = makeRunId()
  const full = { run_id, ...report }

  const { path: resultsFile, total } = await appendRun(cfg, full)
  const status =
    report.overall_status === 'fail' ? `FAIL (${report.gated_failures.join(', ')})` : 'PASS'
  console.error(
    `${status} — appended run ${run_id} → ${path.relative(process.cwd(), resultsFile)}; ${total} run(s) on file`
  )

  return {
    code: report.overall_status === 'fail' ? 1 : 0,
    report: full,
    resultsFile,
    perQuestionRaw
  }
}

// Entry point for `npm run evals`: sweep all embedding subdirs under
// cfg.embeddingsDir, then build the comparison report.
export async function evaluateAndCompare({ overrides, logger = console } = {}) {
  const cfg = await loadConfig({ overrides })

  const golden = await readJsonOrNull(cfg.goldenSet)
  if (!golden || !Array.isArray(golden.questions)) {
    logger.error(`Golden set missing or malformed at ${cfg.goldenSet}`)
    return { code: 3 }
  }
  const problems = validateGolden(golden.questions)
  if (problems.length > 0) {
    logger.error(
      `Golden set at ${cfg.goldenSet} has ${problems.length} problem(s): ${JSON.stringify(problems)}`
    )
    return { code: 3 }
  }

  const sourceDb = await sourceDbRuntime.createSourceDb()

  const stale = await preflight(golden.questions, sourceDb)
  if (stale.length > 0) {
    throw new Error(
      `${stale.length} golden doc id(s) not in the source db: ${JSON.stringify(stale)}`
    )
  }

  let code
  const dirs = await findEmbeddingDirs(cfg.embeddingsDir)
  if (!dirs.length) throw new Error(`No embedding dirs found under ${cfg.embeddingsDir}`)
  console.error(`Sweep: found ${dirs.length} embedding dir(s) under ${cfg.embeddingsDir}`)
  let worstCode = 0
  const prevEmbeddingsDir = process.env.CDS_MCP_EMBEDDINGS_DIR

  try {
    for (const dir of dirs) {
      const label = [cfg.label, ...path.relative(cfg.embeddingsDir, dir).split(path.sep)]
        .filter(Boolean)
        .join('/')
      console.error(`\n→ ${label}`)
      process.env.CDS_MCP_EMBEDDINGS_DIR = dir
      const capire_version = await readCapireVersion(dir)
      const { code: c } = await evaluate({
        sourceDb,
        golden,
        overrides,
        label,
        capire_version
      })
      if (c > worstCode) worstCode = c
    }
  } finally {
    if (prevEmbeddingsDir === undefined) delete process.env.CDS_MCP_EMBEDDINGS_DIR
    else process.env.CDS_MCP_EMBEDDINGS_DIR = prevEmbeddingsDir
  }
  code = worstCode

  try {
    const { compare } = await import('./compare.js')
    await compare({ overrides })
  } catch (err) {
    console.error(`(compare step failed: ${err.message})`)
    if (code === 0) code = 3
  }

  return { code }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  evaluateAndCompare()
    .then((r) => process.exit(r.code))
    .catch((e) => {
      console.error(e)
      process.exit(3)
    })
}
