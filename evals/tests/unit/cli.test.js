import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { run, runAll } from '../../lib/cli.js'

// ---- fixtures -------------------------------------------------------------
// A tiny in-memory index + retriever so no ONNX model / network is touched.
const CHUNK_IDS = ['doc-a#0001', 'doc-b#0002', 'doc-c#0003', 'doc-d#0004', 'doc-e#0005']

function fakeLoadIndex() {
  return async () => ({
    idSet: new Set(CHUNK_IDS),
    count: CHUNK_IDS.length
  })
}

// Retriever that returns a fixed ranking (best-first) for every question.
function fakeRetriever(ranking) {
  return async () => async () => ranking
}

const silentLogger = { log() {}, error() {} }

let tmpDir
let goldenPath
let runsDir

async function writeGolden(questions, name = 'test-golden') {
  await fs.writeFile(goldenPath, JSON.stringify({ golden_set: name, questions }))
}

function baseOverrides(extra = {}) {
  return {
    k: 5,
    paths: { goldenSet: goldenPath, runsDir },
    capire_version: '2026.5.0',
    ...extra
  }
}

// Read result.jsonl as an array of parsed run reports.
async function readResults() {
  const text = await fs.readFile(path.join(runsDir, 'result.jsonl'), 'utf8')
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l))
}

describe('cli tests', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-cli-'))
    goldenPath = path.join(tmpDir, 'golden.json')
    runsDir = path.join(tmpDir, 'runs')
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('happy path: exit 0, appends one line to result.jsonl (no folders, no md)', async () => {
    await writeGolden([
      { id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] },
      { id: 'q-002', question: 'q2', relevant_doc_ids: ['doc-b#0002'] }
    ])
    const res = await run({
      overrides: baseOverrides(),
      logger: silentLogger,
      deps: { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    })
    assert.equal(res.code, 0)
    assert.equal(res.report.overall_status, 'pass')

    const rows = await readResults()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].run_id, res.report.run_id)
    assert.equal(rows[0].config.capire_version, '2026.5.0')
    assert.equal(rows[0].config.golden_set, 'test-golden')

    // no per-run folders, no report.md, only result.jsonl in runsDir
    const entries = await fs.readdir(runsDir)
    assert.deepEqual(entries.sort(), ['result.jsonl'])
  })

  test('run() does not touch CDS_MCP_OFFLINE (entry point owns the flag)', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const deps = { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    delete process.env.CDS_MCP_OFFLINE
    await run({ overrides: baseOverrides(), logger: silentLogger, deps })
    // run() must not set/mutate the env — bin/eval.js sets it once before import.
    assert.equal('CDS_MCP_OFFLINE' in process.env, false)
  })

  test('gated failure → exit 1', async () => {
    // Relevant docs not retrieved at all → recall/hit-rate 0, below gate.
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['not-retrieved#9999'] }])
    // 'not-retrieved#9999' isn't in the index → would trip pre-flight; add it to the index.
    const idxWithMissing = async () => ({
      idSet: new Set([...CHUNK_IDS, 'not-retrieved#9999']),
      count: CHUNK_IDS.length + 1
    })
    const res = await run({
      overrides: baseOverrides(),
      logger: silentLogger,
      deps: { loadIndex: idxWithMissing, makeRetriever: fakeRetriever(CHUNK_IDS) }
    })
    assert.equal(res.code, 1)
    assert.equal(res.report.overall_status, 'fail')
    assert.ok(res.report.gated_failures.includes('recall_at_k'))
  })

  test('pre-flight stale id → exit 2, no run written', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['ghost#dead'] }])
    const res = await run({
      overrides: baseOverrides(),
      logger: silentLogger,
      deps: { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    })
    assert.equal(res.code, 2)
    assert.deepEqual(res.stale, [{ question: 'q-001', doc_id: 'ghost#dead' }])
    // nothing should have been written
    await assert.rejects(() => fs.access(path.join(runsDir, 'result.jsonl')))
  })

  test('missing golden set → exit 3', async () => {
    // goldenPath does not exist
    const res = await run({
      overrides: baseOverrides(),
      logger: silentLogger,
      deps: { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    })
    assert.equal(res.code, 3)
  })

  test('malformed golden question → exit 3, no crash, no run written', async () => {
    // question missing relevant_doc_ids would previously TypeError in preflight
    await writeGolden([{ id: 'q-001', question: 'q1' }])
    const res = await run({
      overrides: baseOverrides(),
      logger: silentLogger,
      deps: { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    })
    assert.equal(res.code, 3)
    await assert.rejects(() => fs.access(path.join(runsDir, 'result.jsonl')))
  })

  test('baseline = oldest run: second run diffs against the first', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    // First run is the baseline (oldest); it has no baseline itself.
    const first = await run({
      overrides: baseOverrides(),
      logger: silentLogger,
      deps: { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    })
    assert.equal(first.report.baseline_run_id, null)
    // Second run with a WORSE ranking (relevant doc pushed to rank 3).
    const worse = ['doc-x#000x', 'doc-y#000y', 'doc-a#0001', 'doc-b#0002', 'doc-c#0003']
    const second = await run({
      overrides: baseOverrides(),
      logger: silentLogger,
      deps: { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(worse) }
    })
    assert.equal(second.report.baseline_run_id, first.report.run_id) // diffed vs oldest
    assert.ok(second.report.aggregate.mrr.delta < 0) // mrr dropped vs baseline
    assert.match(second.report.diagnosis, /ranking\/scoring regression/)
  })

  test('pinned baselineRunId: diffs against the pinned run, not the oldest', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const deps = { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    const r1 = await run({ overrides: baseOverrides(), logger: silentLogger, deps })
    const r2 = await run({ overrides: baseOverrides(), logger: silentLogger, deps })
    // Pin the SECOND run as baseline for a third run — not the oldest (r1).
    const r3 = await run({
      overrides: baseOverrides({ baselineRunId: r2.report.run_id }),
      logger: silentLogger,
      deps
    })
    assert.equal(r3.report.baseline_run_id, r2.report.run_id)
    assert.notEqual(r3.report.baseline_run_id, r1.report.run_id)
  })

  test('pinned baselineRunId not found → no baseline, no crash', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const deps = { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    await run({ overrides: baseOverrides(), logger: silentLogger, deps })
    const r = await run({
      overrides: baseOverrides({ baselineRunId: 'no-such-run' }),
      logger: silentLogger,
      deps
    })
    assert.equal(r.report.baseline_run_id, null)
  })

  test('result.jsonl accumulates one line per run, chronologically', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const deps = { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    for (let i = 0; i < 3; i++) {
      await run({ overrides: baseOverrides({ output: { keepRuns: 20 } }), logger: silentLogger, deps })
    }
    const rows = await readResults()
    assert.equal(rows.length, 3)
    // sorted by run_id ascending
    const ids = rows.map(r => r.run_id)
    assert.deepEqual(ids, [...ids].sort())
  })

  test('run hygiene: caps result.jsonl to the most recent keepRuns lines', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const deps = { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    for (let i = 0; i < 5; i++) {
      await run({ overrides: baseOverrides({ output: { keepRuns: 2 } }), logger: silentLogger, deps })
    }
    const rows = await readResults()
    assert.equal(rows.length, 2) // capped to keepRuns, newest kept
  })

  test('custom resultsName is honored', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    await run({
      overrides: baseOverrides({ output: { keepRuns: 20, resultsName: 'runs.jsonl' } }),
      logger: silentLogger,
      deps: { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    })
    const entries = await fs.readdir(runsDir)
    assert.deepEqual(entries.sort(), ['runs.jsonl'])
  })

  test('runAll runs the eval config.runs times, then writes compare', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const res = await runAll({
      overrides: baseOverrides({ runs: 3 }),
      logger: silentLogger,
      deps: { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    })
    assert.equal(res.code, 0)
    assert.equal(res.runs, 3)
    const rows = await readResults()
    assert.equal(rows.length, 3) // three runs appended
    // compare always runs afterwards → compare.html present
    await fs.access(path.join(runsDir, 'compare.html'))
  })

  test('runAll defaults to a single run + compare', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['doc-a#0001'] }])
    const res = await runAll({
      overrides: baseOverrides(), // runs defaults to 1
      logger: silentLogger,
      deps: { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    })
    assert.equal(res.runs, 1)
    assert.equal((await readResults()).length, 1)
    await fs.access(path.join(runsDir, 'compare.html'))
  })

  test('runAll stops on a hard error (stale pre-flight) and still compares', async () => {
    await writeGolden([{ id: 'q-001', question: 'q1', relevant_doc_ids: ['ghost#dead'] }])
    const res = await runAll({
      overrides: baseOverrides({ runs: 3 }),
      logger: silentLogger,
      deps: { loadIndex: fakeLoadIndex(), makeRetriever: fakeRetriever(CHUNK_IDS) }
    })
    assert.equal(res.code, 2) // pre-flight abort code surfaces
    // no runs were written (each attempt aborts before append)
    await assert.rejects(() => fs.access(path.join(runsDir, 'result.jsonl')))
  })
})
