import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import { loadConfig } from './config.js'
import { preflight, validateGolden, buildReport, makeRunId } from './report.js'
import { appendRun, readRuns, baselineRun } from './store.js'
import { setModel } from '../../lib/calculateEmbeddings.js'
import { createSourceDb } from './createSourceDb/createSourceDb.js'
import { resolveIds } from './ids.js'
import tools from '../../lib/tools.js'

async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

const MODELS = [
  { id: 'Xenova/all-MiniLM-L6-v2',              short: 'llm'    },
  { id: 'Xenova/all-MiniLM-L6-v2',              short: 'xenova'    },
  { id: 'nomic-ai/nomic-embed-text-v1.5',        short: 'nomic'     },
  { id: 'perplexity-ai/pplx-embed-v1-0.6b',      short: 'pplx'      },
  { id: 'sentence-transformers/all-MiniLM-L6-v2', short: 'transMini' },
]

async function makeSearchDocsRunner(k, sourceDb) {
  const retrieve = async function (q) {
    const out = await tools.search_docs.handler({ query: q.question, maxResults: k })
    return resolveIds(out ? out.split('\n---\n') : [], q, sourceDb)
  }
  return retrieve
}

// `deps` is a test seam: pass { loadIndex, makeRetriever } to score against a
// fixture without loading the ONNX model. Production omits it.
export async function evaluate({ sourceDb, configPath, overrides, deps = {} } = {}) {
  const cfg = await loadConfig({ configPath, overrides })

  if (deps.model) setModel(deps.model)

  const makeRetrieverFn = deps.makeRetriever || makeSearchDocsRunner

  const golden = await readJsonOrNull(cfg.paths.goldenSet)
  if (!golden || !Array.isArray(golden.questions)) {
    console.error(`Golden set missing or malformed at ${cfg.paths.goldenSet}`)
    return { code: 3 }
  }
  const problems = validateGolden(golden.questions)
  if (problems.length > 0) {
    console.error(`Golden set at ${cfg.paths.goldenSet} has ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  ${p}`)
    return { code: 3 }
  }
  // Baseline (read before this run is appended): pinned run if set, else oldest.
  const baseline = baselineRun(await readRuns(cfg), cfg.baselineRunId)
  if (cfg.baselineRunId && !baseline) {
    console.error(`(note: pinned baseline "${cfg.baselineRunId}" not found in result.jsonl — this run has no baseline)`)
  }

  // Warn (don't abort) on stale relevant_doc_ids — the corpus likely re-indexed
  // and these labels no longer match; they'll score as misses until refreshed.
  const stale = await preflight(golden.questions, sourceDb)
  if (stale.length > 0) {
    console.error(`PRE-FLIGHT WARNING: ${stale.length} golden doc id(s) not in the current index (will score as misses — refresh the golden set, see docs/README.md):`)
    for (const s of stale) console.error(`  ${s.question}: ${s.doc_id}`)
  }

  const retrieve = await makeRetrieverFn(cfg.k, sourceDb)
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
  console.error(`${status} — appended run ${run_id} → ${path.relative(process.cwd(), resultsFile)}; ${total} run(s) on file`)

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
export async function evaluateAndCompare({ configPath, overrides, deps = {} } = {}) {
  const sourceDb = await createSourceDb()

  const cfg = await loadConfig({ configPath, overrides })

  let code
  let perQuestionRaw
  if (cfg.paths.embeddingsSweepDir) {
    const dirs = await findEmbeddingDirs(cfg.paths.embeddingsSweepDir)
    if (!dirs.length) throw new Error(`No embedding dirs found under ${cfg.paths.embeddingsSweepDir}`)
    console.error(`Sweep: found ${dirs.length} embedding dir(s) under ${cfg.paths.embeddingsSweepDir}`)
    const sweepBasename = path.basename(cfg.paths.embeddingsSweepDir)
    let worstCode = 0
    for (const dir of dirs) {
      process.env.LOCAL_EMBEDDINGS_DIR = dir
      const model = MODELS.find(m => dir.includes(m.short))
      if (model) deps.model = model.id
      const segments = path.relative(cfg.paths.embeddingsSweepDir, dir).split(path.sep)
      const label = [...segments].join('/')
      console.error(`\n→ ${label}`)
      const { code: c } = await evaluate({ sourceDb, configPath, overrides: { ...overrides, label }, deps })
      if (c > worstCode) worstCode = c
    }
    code = worstCode
  } else {
    ;({ code, perQuestionRaw } = await evaluate({ sourceDb, configPath, overrides, deps }))
  }

  try {
    const { compare } = await import('./compare.js')
    await compare({ configPath, overrides, perQuestionRaw })
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
