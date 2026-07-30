import path from 'path'
import fs from 'fs/promises'
import { loadConfig, METRIC_KEYS } from './config.js'
import { loadIndex, makeDefaultRetriever } from './retriever.js'
import { preflight, buildReport, makeRunId, runIdToFilename, renderConsoleWithBaseline } from './runner.js'

async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// Write the run report to runs/, update latest.json, and prune old timestamped
// runs so repeated runs never pollute the tree. Returns paths written.
async function persistRun(cfg, full) {
  const runsDir = cfg.paths.runsDir
  await fs.mkdir(runsDir, { recursive: true })
  const body = JSON.stringify(full, null, 2) + '\n'
  const written = []

  // Always update the stable pointer.
  const latestPath = path.join(runsDir, cfg.output.latestName)
  await fs.writeFile(latestPath, body)
  written.push(latestPath)

  // Optionally keep a timestamped copy.
  if (cfg.output.writeTimestamped) {
    const runPath = path.join(runsDir, runIdToFilename(full.run_id))
    await fs.writeFile(runPath, body)
    written.push(runPath)
    await pruneRuns(runsDir, cfg.output.latestName, cfg.output.keepRuns)
  }
  return { written, latestPath }
}

// Keep at most `keep` timestamped eval-run files (newest by filename, which
// sorts chronologically thanks to the ISO timestamp). keep < 0 => keep all.
async function pruneRuns(runsDir, latestName, keep) {
  if (keep < 0) return
  const entries = await fs.readdir(runsDir)
  const runs = entries
    .filter(f => f.startsWith('eval-run-') && f.endsWith('.json') && f !== latestName)
    .sort() // ISO timestamp prefix → lexical sort == chronological
  const excess = runs.length - keep
  for (let i = 0; i < excess; i++) {
    await fs.unlink(path.join(runsDir, runs[i])).catch(() => {})
  }
}

export async function run({ configPath, overrides, logger = console } = {}) {
  const cfg = await loadConfig({ configPath, overrides })

  // Offline flag must reach the retrieval internals via env before they load.
  if (cfg.offline) process.env.CDS_MCP_OFFLINE = 'true'

  const golden = await readJsonOrNull(cfg.paths.goldenSet)
  if (!golden || !Array.isArray(golden.questions)) {
    logger.error(`Golden set missing or malformed at ${cfg.paths.goldenSet}`)
    return { code: 3 }
  }
  const baseline = await readJsonOrNull(cfg.paths.baseline)

  const index = await loadIndex()

  // Pre-flight: fail loudly on stale relevant_doc_ids.
  const stale = preflight(golden.questions, index.idSet)
  if (stale.length > 0) {
    logger.error('PRE-FLIGHT FAILED: golden set references doc ids missing from the current index.')
    logger.error('The corpus likely re-indexed and these labels are stale — refresh the golden set (see docs/README.md).')
    for (const s of stale) logger.error(`  ${s.question}: ${s.doc_id}`)
    return { code: 2, stale }
  }

  const retrieve = await makeDefaultRetriever()
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
    corpus_version: cfg.corpus.corpus_version,
    index_rev: cfg.corpus.index_rev,
    embedding_model: cfg.corpus.embedding_model,
    golden_set: golden.golden_set,
    golden_set_size: golden.questions.length,
    k: cfg.k
  }

  const report = buildReport({ config, perQuestionRaw, baseline, gates: cfg.gates })
  const run_id = makeRunId()
  const full = { run_id, ...report }

  const { written, latestPath } = await persistRun(cfg, full)

  logger.log(renderConsoleWithBaseline(full, run_id, { chunkCount: index.count }, baseline))
  logger.error(`\n(report written to ${path.relative(process.cwd(), latestPath)}${written.length > 1 ? ' + timestamped copy' : ''})`)

  return { code: report.overall_status === 'fail' ? 1 : 0, report: full, written }
}
