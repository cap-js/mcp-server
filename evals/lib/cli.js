import path from 'path'
import fs from 'fs/promises'
import { loadConfig, METRIC_KEYS } from './config.js'
import { loadIndex, makeDefaultRetriever } from './retriever.js'
import { preflight, buildReport, makeRunId, renderConsoleWithBaseline } from './runner.js'
import { appendRun } from './store.js'

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

  // Offline flag must reach the retrieval internals via env before they load.
  if (cfg.offline) process.env.CDS_MCP_OFFLINE = 'true'

  const golden = await readJsonOrNull(cfg.paths.goldenSet)
  if (!golden || !Array.isArray(golden.questions)) {
    logger.error(`Golden set missing or malformed at ${cfg.paths.goldenSet}`)
    return { code: 3 }
  }
  const baseline = await readJsonOrNull(cfg.paths.baseline)

  const index = await loadIndexFn()

  // Pre-flight: fail loudly on stale relevant_doc_ids.
  const stale = preflight(golden.questions, index.idSet)
  if (stale.length > 0) {
    logger.error('PRE-FLIGHT FAILED: golden set references doc ids missing from the current index.')
    logger.error('The corpus likely re-indexed and these labels are stale — refresh the golden set (see docs/README.md).')
    for (const s of stale) logger.error(`  ${s.question}: ${s.doc_id}`)
    return { code: 2, stale }
  }

  const retrieve = await makeRetrieverFn()
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
