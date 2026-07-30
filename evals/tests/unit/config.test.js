import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, METRIC_KEYS } from '../../lib/config.js'

// Snapshot & restore EVAL_* env between tests so overrides don't leak.
const EVAL_ENV = [
  'EVAL_CONFIG', 'EVAL_K', 'EVAL_GOLDEN_SET', 'EVAL_RUNS_DIR',
  'EVAL_CAPIRE_VERSION', 'EVAL_GATES',
  'EVAL_KEEP_RUNS', 'EVAL_RESULTS_NAME', 'EVAL_COMPARE_FORMAT', 'CDS_MCP_OFFLINE'
]
function clearEnv() {
  for (const k of EVAL_ENV) delete process.env[k]
}

describe('config tests', () => {
  afterEach(clearEnv)

  test('loads defaults from config.json', async () => {
    clearEnv()
    const cfg = await loadConfig()
    assert.equal(cfg.k, 5)
    assert.equal(cfg.gates.recall_at_k, 0.8)
    assert.equal(cfg.gates.precision_at_k, null)
    assert.ok(cfg.paths.goldenSet.endsWith('data/golden-set.json'))
    assert.ok(cfg.paths.runsDir.endsWith('runs'))
    // all metric keys present in gates
    for (const key of METRIC_KEYS) assert.ok(key in cfg.gates)
  })

  test('env vars override config.json', async () => {
    clearEnv()
    process.env.EVAL_K = '10'
    process.env.EVAL_CAPIRE_VERSION = '2026.9.9'
    const cfg = await loadConfig()
    assert.equal(cfg.k, 10)
    assert.equal(cfg.capire_version, '2026.9.9')
  })

  test('EVAL_GATES string overrides individual gates', async () => {
    clearEnv()
    process.env.EVAL_GATES = 'recall_at_k=0.9,mrr=0.7,ndcg_at_k=0.6'
    const cfg = await loadConfig()
    assert.equal(cfg.gates.recall_at_k, 0.9)
    assert.equal(cfg.gates.mrr, 0.7)
    assert.equal(cfg.gates.ndcg_at_k, 0.6) // was null, now gated
    assert.equal(cfg.gates.hit_rate_at_k, 0.8) // untouched from file
  })

  test('EVAL_GATES supports null to un-gate', async () => {
    clearEnv()
    process.env.EVAL_GATES = 'mrr=null'
    const cfg = await loadConfig()
    assert.equal(cfg.gates.mrr, null)
  })

  test('programmatic overrides win last', async () => {
    clearEnv()
    process.env.EVAL_K = '7'
    const cfg = await loadConfig({ overrides: { k: 3, gates: { recall_at_k: 0.99 } } })
    assert.equal(cfg.k, 3) // override beats env
    assert.equal(cfg.gates.recall_at_k, 0.99)
  })

  test('output hygiene knobs are configurable', async () => {
    clearEnv()
    process.env.EVAL_KEEP_RUNS = '3'
    process.env.EVAL_RESULTS_NAME = 'runs.jsonl'
    const cfg = await loadConfig()
    assert.equal(cfg.output.keepRuns, 3)
    assert.equal(cfg.output.resultsName, 'runs.jsonl')
  })

  test('compareFormat defaults to html and is overridable to md', async () => {
    clearEnv()
    assert.equal((await loadConfig()).output.compareFormat, 'html')
    process.env.EVAL_COMPARE_FORMAT = 'md'
    assert.equal((await loadConfig()).output.compareFormat, 'md')
  })

  test('rejects invalid compareFormat', async () => {
    clearEnv()
    process.env.EVAL_COMPARE_FORMAT = 'pdf'
    await assert.rejects(() => loadConfig(), /compareFormat must be "html" or "md"/)
  })

  test('rejects invalid k', async () => {
    clearEnv()
    process.env.EVAL_K = '0'
    await assert.rejects(() => loadConfig(), /k must be a positive integer/)
  })

  test('rejects out-of-range gate', async () => {
    clearEnv()
    process.env.EVAL_GATES = 'recall_at_k=1.5'
    await assert.rejects(() => loadConfig(), /must be null or a number in \[0,1\]/)
  })

  test('rejects unknown gate metric', async () => {
    clearEnv()
    process.env.EVAL_GATES = 'bogus_metric=0.5'
    await assert.rejects(() => loadConfig(), /unknown metric/)
  })

  test('absolute EVAL_RUNS_DIR is respected', async () => {
    clearEnv()
    process.env.EVAL_RUNS_DIR = '/tmp/eval-runs-abs'
    const cfg = await loadConfig()
    assert.equal(cfg.paths.runsDir, '/tmp/eval-runs-abs')
  })
})
