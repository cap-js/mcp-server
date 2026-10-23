import { it, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { evaluate, evaluateAndCompare } from '../../lib/index.js'
import { sourceDbRuntime } from '../../lib/createSourceDb/createSourceDb.js'
import { retrievalRuntime } from '../../lib/retrieval.js'

const silentLogger = { log() {}, error() {} }

const CHUNK_IDS = ['doc-a#0001', 'doc-b#0002', 'doc-c#0003', 'doc-d#0004', 'doc-e#0005']

function retriever(ranking = CHUNK_IDS) {
  const chunks = ranking.map((id) => ({ ids: [id], text: '' }))
  return mock.fn(async () => mock.fn(async () => chunks))
}

function mockEvaluationRuntime(makeSearchDocsRunner = retriever()) {
  const fakeSourceDb = { run: mock.fn(async () => CHUNK_IDS.map((id) => ({ source: id }))) }
  mock.method(retrievalRuntime, 'makeSearchDocsRunner', makeSearchDocsRunner)
  mock.method(sourceDbRuntime, 'createSourceDb', async () => fakeSourceDb)
}

let tmpDir
let goldenPath
let runsDir

async function writeGolden(questions, name = 'test-golden') {
  await fs.writeFile(goldenPath, JSON.stringify({ golden_set: name, questions }))
}

async function loadGolden() {
  return JSON.parse(await fs.readFile(goldenPath, 'utf8'))
}

function baseConfig(extra = {}) {
  const base = {
    k: 5,
    goldenSet: goldenPath,
    output: { runsDir },
    embeddingsDir: null
  }
  return { ...base, ...extra, output: { ...base.output, ...(extra.output || {}) } }
}

async function readResults() {
  const text = await fs.readFile(path.join(runsDir, 'result.jsonl'), 'utf8')
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe('evaluate', () => {
  beforeEach(async () => {
    mockEvaluationRuntime()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-cli-'))
    goldenPath = path.join(tmpDir, 'golden.json')
    runsDir = path.join(tmpDir, 'runs')
  })
  afterEach(async () => {
    mock.restoreAll()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should exit 0 and append one result line to result.jsonl', async () => {
    await writeGolden([
      { id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] },
      { id: 'q-002', question: 'q2', relevant_doc_ids: ['doc-b#0002'] }
    ])

    const res = await evaluate({
      golden: await loadGolden(),
      config: baseConfig(),
      logger: silentLogger
    })

    assert.equal(res.code, 0)
    assert.equal(res.report.overall_status, 'pass')
    const rows = await readResults()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].run_id, res.report.run_id)
    assert.equal(rows[0].config.capire_version, 'unknown')
    assert.equal(rows[0].config.golden_set, 'test-golden')
    const entries = await fs.readdir(runsDir)
    assert.deepEqual(entries.sort(), ['result.jsonl'])
  })

  it('should record the label in the report config', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])

    const res = await evaluate({
      golden: await loadGolden(),
      config: baseConfig(),
      label: 'tuned chunker',
      logger: silentLogger
    })

    assert.ok(res.report.config.label.includes('tuned chunker'))
    const rows = await readResults()
    assert.ok(rows[0].config.label.includes('tuned chunker'))
  })

  it('should credit a multi-section chunk for every section it covers', async () => {
    const firstUrl = 'https://x/docs/get-started/#initial-setup'
    const secondUrl = 'https://x/docs/get-started/#nodejs-and-cds-dk'
    await writeGolden([
      { id: 'q-001', question: 'installing cds-dk', relevant_doc_ids: [secondUrl] }
    ])
    mock.restoreAll()
    mockEvaluationRuntime(
      mock.fn(async () => mock.fn(async () => [{ ids: [firstUrl, secondUrl], text: '' }]))
    )

    const res = await evaluate({
      golden: await loadGolden(),
      config: baseConfig(),
      logger: silentLogger
    })

    assert.equal(res.report.per_question[0].metrics.hit_rate_at_k, 1)
    assert.equal(res.report.per_question[0].metrics.recall_at_k, 1)
  })

  it('should not set or mutate CDS_MCP_OFFLINE', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    delete process.env.CDS_MCP_OFFLINE

    await evaluate({ golden: await loadGolden(), config: baseConfig(), logger: silentLogger })

    assert.equal('CDS_MCP_OFFLINE' in process.env, false)
  })

  it('should exit 1 with overall_status fail when retrieval is below the gate threshold', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['not-retrieved#9999'] }])

    const res = await evaluate({
      golden: await loadGolden(),
      config: baseConfig(),
      logger: silentLogger
    })

    assert.equal(res.code, 1)
    assert.equal(res.report.overall_status, 'fail')
    assert.ok(res.report.gated_failures.includes('recall_at_k'))
  })

  it('should score a stale golden id as a miss and still write the run', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['ghost#dead'] }])

    const res = await evaluate({
      golden: await loadGolden(),
      config: baseConfig(),
      logger: silentLogger
    })

    assert.equal(res.code, 1)
    assert.equal(res.report.per_question[0].metrics.recall_at_k, 0)
    await fs.access(path.join(runsDir, 'result.jsonl'))
  })

  it('should exit 3 when the golden set is missing', async () => {
    const res = await evaluateAndCompare({ config: baseConfig() })

    assert.equal(res.code, 3)
  })

  it('should rethrow a non-ENOENT error when reading the golden set', async () => {
    await fs.mkdir(goldenPath)

    await assert.rejects(() => evaluateAndCompare({ config: baseConfig() }), /EISDIR/)
  })

  it('should exit 3 and write no run when the golden question is malformed', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1' }])

    const res = await evaluateAndCompare({ config: baseConfig() })

    assert.equal(res.code, 3)
    await assert.rejects(() => fs.access(path.join(runsDir, 'result.jsonl')))
  })

  it('should diff the second run against the first (oldest) run as baseline', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const first = await evaluate({
      golden: await loadGolden(),
      config: baseConfig(),
      logger: silentLogger
    })
    assert.equal(first.report.baseline_run_id, null)
    const worse = ['doc-x#000x', 'doc-y#000y', 'doc-a#0001', 'doc-b#0002', 'doc-c#0003']
    mock.restoreAll()
    mockEvaluationRuntime(retriever(worse))

    const second = await evaluate({
      golden: await loadGolden(),
      config: baseConfig(),
      logger: silentLogger
    })

    assert.equal(second.report.baseline_run_id, first.report.run_id)
    assert.ok(second.report.aggregate.mrr.delta < 0)
    assert.match(second.report.diagnosis, /ranking\/scoring regression/)
  })

  it('should diff against the pinned run when baselineRunId is set', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const r1 = await evaluate({
      golden: await loadGolden(),
      config: baseConfig(),
      logger: silentLogger
    })
    const r2 = await evaluate({
      golden: await loadGolden(),
      config: baseConfig(),
      logger: silentLogger
    })

    const r3 = await evaluate({
      golden: await loadGolden(),
      config: baseConfig({ baselineRunId: r2.report.run_id }),
      logger: silentLogger
    })

    assert.equal(r3.report.baseline_run_id, r2.report.run_id)
    assert.notEqual(r3.report.baseline_run_id, r1.report.run_id)
  })

  it('should proceed without a baseline when the pinned baselineRunId is not found', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    await evaluate({ golden: await loadGolden(), config: baseConfig(), logger: silentLogger })

    const r = await evaluate({
      golden: await loadGolden(),
      config: baseConfig({ baselineRunId: 'no-such-run' }),
      logger: silentLogger
    })

    assert.equal(r.report.baseline_run_id, null)
  })

  it('should not pick an automatic baseline from a run with a different k', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    await evaluate({ golden: await loadGolden(), config: baseConfig(), logger: silentLogger })

    const second = await evaluate({
      golden: await loadGolden(),
      config: baseConfig({ k: 3 }),
      logger: silentLogger
    })

    assert.equal(second.report.config.k, 3)
    assert.equal(second.report.baseline_run_id, null)
  })

  it('should not pick an automatic baseline from a run with a different golden set', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }], 'set-a')
    await evaluate({ golden: await loadGolden(), config: baseConfig(), logger: silentLogger })

    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }], 'set-b')
    const second = await evaluate({
      golden: await loadGolden(),
      config: baseConfig(),
      logger: silentLogger
    })

    assert.equal(second.report.config.golden_set, 'set-b')
    assert.equal(second.report.baseline_run_id, null)
  })

  it('should still use a pinned baseline even when k differs', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const r1 = await evaluate({
      golden: await loadGolden(),
      config: baseConfig(),
      logger: silentLogger
    })

    const r2 = await evaluate({
      golden: await loadGolden(),
      config: baseConfig({ k: 3, baselineRunId: r1.report.run_id }),
      logger: silentLogger
    })

    assert.equal(r2.report.baseline_run_id, r1.report.run_id)
  })

  it('should accumulate one line per run chronologically in result.jsonl', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])

    for (let i = 0; i < 3; i++) {
      await evaluate({
        golden: await loadGolden(),
        config: baseConfig({ output: { keepRuns: 20 } }),
        logger: silentLogger
      })
    }

    const rows = await readResults()
    assert.equal(rows.length, 3)
    const ids = rows.map((r) => r.run_id)
    assert.deepEqual(ids, [...ids].sort())
  })

  it('should cap result.jsonl to the most recent keepRuns lines', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])

    for (let i = 0; i < 5; i++) {
      await evaluate({
        golden: await loadGolden(),
        config: baseConfig({ output: { keepRuns: 2 } }),
        logger: silentLogger
      })
    }

    const rows = await readResults()
    assert.equal(rows.length, 2)
  })

  it('should write results to the custom resultsName when configured', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])

    await evaluate({
      golden: await loadGolden(),
      config: baseConfig({ output: { keepRuns: 20, resultsName: 'runs.jsonl' } }),
      logger: silentLogger
    })

    const entries = await fs.readdir(runsDir)
    assert.deepEqual(entries.sort(), ['runs.jsonl'])
  })

  it('should run the eval once and write a compare file', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const embDir = path.join(tmpDir, 'embeddings')
    await fs.mkdir(embDir, { recursive: true })
    await fs.writeFile(path.join(embDir, 'code-chunks.json'), '{}')

    const res = await evaluateAndCompare({
      config: { ...baseConfig(), label: null, embeddingsDir: embDir },
      logger: silentLogger
    })

    assert.equal(res.code, 0)
    const rows = await readResults()
    assert.equal(rows.length, 1)
    await fs.access(path.join(runsDir, 'compare.html'))
  })

  it('should exit nonzero when the compare step fails after the evals pass', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const embDir = path.join(tmpDir, 'embeddings')
    await fs.mkdir(embDir, { recursive: true })
    await fs.writeFile(path.join(embDir, 'code-chunks.json'), '{}')
    // Make the report write fail: a directory where compare.html must be written.
    await fs.mkdir(path.join(runsDir, 'compare.html'), { recursive: true })

    const res = await evaluateAndCompare({
      config: { ...baseConfig(), label: null, embeddingsDir: embDir },
      logger: silentLogger
    })

    assert.notEqual(res.code, 0)
    const rows = await readResults()
    assert.equal(rows.length, 1) // the eval itself still ran and was recorded
  })

  it('should exit 3 and not write results when the golden set is missing', async () => {
    const res = await evaluateAndCompare({ config: baseConfig(), logger: silentLogger })

    assert.equal(res.code, 3)
    await assert.rejects(() => fs.access(path.join(runsDir, 'result.jsonl')))
  })

  describe('side-effects', () => {
    it('should not mutate the config object passed to evaluate', async () => {
      await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
      const config = baseConfig()
      const keysBefore = Object.keys(config)

      await evaluate({ golden: await loadGolden(), config, logger: silentLogger })

      assert.deepEqual(Object.keys(config), keysBefore)
    })
  })
})

describe('evaluateSweep', () => {
  let tmpDir, goldenPath, runsDir, sweepDir

  beforeEach(async () => {
    mockEvaluationRuntime()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-sweep-'))
    goldenPath = path.join(tmpDir, 'golden.json')
    runsDir = path.join(tmpDir, 'runs')
    sweepDir = path.join(tmpDir, 'sweep')
  })
  afterEach(async () => {
    mock.restoreAll()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeGolden(questions) {
    await fs.writeFile(goldenPath, JSON.stringify({ golden_set: 'test', questions }))
  }

  function sweepConfig(extra = {}) {
    const base = {
      k: 5,
      label: null,
      goldenSet: goldenPath,
      output: { runsDir },
      embeddingsDir: sweepDir
    }
    return { ...base, ...extra, output: { ...base.output, ...(extra.output || {}) } }
  }

  async function readResults() {
    const text = await fs.readFile(path.join(runsDir, 'result.jsonl'), 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }

  it('should throw when no embedding dirs are found under sweepDir', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    await fs.mkdir(sweepDir, { recursive: true })

    await assert.rejects(
      () => evaluateAndCompare({ config: sweepConfig(), logger: silentLogger }),
      /No embedding dirs found/
    )
  })

  it('should run once per embedding dir and append each result to result.jsonl', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    await fs.mkdir(path.join(sweepDir, 'model-a', 'cfg-1'), { recursive: true })
    await fs.mkdir(path.join(sweepDir, 'model-a', 'cfg-2'), { recursive: true })
    for (const sub of ['cfg-1', 'cfg-2']) {
      await fs.writeFile(path.join(sweepDir, 'model-a', sub, 'code-chunks.json'), '{}')
    }

    const res = await evaluateAndCompare({ config: sweepConfig(), logger: silentLogger })

    const rows = await readResults()
    assert.equal(rows.length, 2)
    const labels = rows.map((r) => r.config.label).sort()
    assert.deepEqual(labels, ['model-a/cfg-1', 'model-a/cfg-2'])
    assert.ok(res.code === 0 || res.code === 1)
  })

  it('should build the label from all path segments relative to sweepDir', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const dir = path.join(sweepDir, 'group', 'subgroup', 'variant')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'code-chunks.json'), '{}')

    await evaluateAndCompare({ config: sweepConfig(), logger: silentLogger })

    const rows = await readResults()
    assert.equal(rows[0].config.label, 'group/subgroup/variant')
  })

  it('should include only dirs that contain code-chunks.json', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const hasChunks = path.join(sweepDir, 'has-chunks')
    await fs.mkdir(hasChunks, { recursive: true })
    await fs.writeFile(path.join(hasChunks, 'code-chunks.json'), '{}')
    await fs.mkdir(path.join(sweepDir, 'no-chunks'), { recursive: true })

    await evaluateAndCompare({ config: sweepConfig(), logger: silentLogger })

    const rows = await readResults()
    assert.equal(rows.length, 1)
    assert.ok(rows[0].config.label.endsWith('has-chunks'))
  })

  describe('side-effects', () => {
    it('should not mutate the config object passed to evaluateAndCompare', async () => {
      await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
      const hasChunks = path.join(sweepDir, 'has-chunks')
      await fs.mkdir(hasChunks, { recursive: true })
      await fs.writeFile(path.join(hasChunks, 'code-chunks.json'), '{}')
      const config = sweepConfig()
      const keysBefore = Object.keys(config)

      await evaluateAndCompare({ config, logger: silentLogger })

      assert.deepEqual(Object.keys(config), keysBefore)
    })
  })
})
