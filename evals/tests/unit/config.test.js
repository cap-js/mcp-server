import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, METRIC_KEYS } from '../../lib/config.js'

// Snapshot & restore the two honoured env vars between tests so overrides don't leak.
const EVAL_ENV = ['EVAL_LABEL', 'EVAL_RUNS_DIR']
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
    assert.ok(cfg.paths.embeddingsSweepDir === null || typeof cfg.paths.embeddingsSweepDir === 'string')
    // all metric keys present in gates
    for (const key of METRIC_KEYS) assert.ok(key in cfg.gates)
  })

  test('label is set via EVAL_LABEL / override (empty by default in code)', async () => {
    clearEnv()
    // Code default is '' (config.json may set its own value, so don't assume '').
    assert.equal((await loadConfig({ configPath: '/no/such/config.json' })).label, '')
    process.env.EVAL_LABEL = 'tuned chunker'
    assert.equal((await loadConfig()).label, 'tuned chunker') // env
    const cfg = await loadConfig({ overrides: { label: 'baseline v1' } })
    assert.equal(cfg.label, 'baseline v1') // override wins over env
  })

  test('EVAL_RUNS_DIR points at another corpus\' results (absolute respected)', async () => {
    clearEnv()
    process.env.EVAL_RUNS_DIR = '/tmp/eval-runs-abs'
    assert.equal((await loadConfig()).paths.runsDir, '/tmp/eval-runs-abs')
  })

  test('programmatic overrides win last', async () => {
    clearEnv()
    const cfg = await loadConfig({ overrides: { k: 3, gates: { recall_at_k: 0.99 }, output: { keepRuns: 3, compareFormat: 'md' } } })
    assert.equal(cfg.k, 3)
    assert.equal(cfg.gates.recall_at_k, 0.99)
    assert.equal(cfg.output.keepRuns, 3)
    assert.equal(cfg.output.compareFormat, 'md')
  })

  test('compareFormat defaults to html', async () => {
    clearEnv()
    assert.equal((await loadConfig()).output.compareFormat, 'html')
  })

  test('rejects invalid compareFormat', async () => {
    clearEnv()
    await assert.rejects(
      () => loadConfig({ overrides: { output: { compareFormat: 'pdf' } } }),
      /compareFormat must be "html" or "md"/
    )
  })

  test('rejects invalid k', async () => {
    clearEnv()
    await assert.rejects(() => loadConfig({ overrides: { k: 0 } }), /k must be a positive integer/)
  })

  test('rejects out-of-range gate', async () => {
    clearEnv()
    await assert.rejects(
      () => loadConfig({ overrides: { gates: { recall_at_k: 1.5 } } }),
      /must be null or a number in \[0,1\]/
    )
  })

  test('validates gates on non-default metrics too (precision_at_k)', async () => {
    clearEnv()
    await assert.rejects(
      () => loadConfig({ overrides: { gates: { precision_at_k: 1.5 } } }),
      /gate precision_at_k must be null or a number in \[0,1\]/
    )
  })

  test('rejects keepRuns = 0 (would wipe the just-appended run)', async () => {
    clearEnv()
    await assert.rejects(() => loadConfig({ overrides: { output: { keepRuns: 0 } } }), /keepRuns must be -1 .* or a positive integer/)
  })

  test('rejects fractional keepRuns', async () => {
    clearEnv()
    await assert.rejects(() => loadConfig({ overrides: { output: { keepRuns: 1.5 } } }), /keepRuns must be -1/)
  })

  test('accepts keepRuns = -1 (keep all)', async () => {
    clearEnv()
    const cfg = await loadConfig({ overrides: { output: { keepRuns: -1 } } })
    assert.equal(cfg.output.keepRuns, -1)
  })

  test('paths.embeddingsSweepDir resolves absolute path via override', async () => {
    clearEnv()
    const cfg = await loadConfig({ overrides: { paths: { embeddingsSweepDir: '/abs/sweep' } } })
    assert.equal(cfg.paths.embeddingsSweepDir, '/abs/sweep')
  })

  test('paths.embeddingsSweepDir is null when not set', async () => {
    clearEnv()
    const cfg = await loadConfig({ configPath: '/no/such/config.json' })
    assert.equal(cfg.paths.embeddingsSweepDir, null)
  })
})
