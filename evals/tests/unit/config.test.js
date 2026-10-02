import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, METRIC_KEYS } from '../../lib/config.js'

// Snapshot & restore the honoured env var between tests so overrides don't leak.
const EVAL_ENV = ['EVAL_LABEL']
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
    assert.ok(cfg.goldenSet.endsWith('data/golden-set.json'))
    assert.ok(cfg.output.runsDir.endsWith('runs'))
    assert.ok(typeof cfg.embeddingsDir === 'string')
    // all metric keys present in gates
    for (const key of METRIC_KEYS) assert.ok(key in cfg.gates)
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

  test('embeddingsDir resolves absolute path via override', async () => {
    clearEnv()
    const cfg = await loadConfig({ overrides: { embeddingsDir: '/abs/sweep' } })
    assert.equal(cfg.embeddingsDir, '/abs/sweep')
  })

  test('embeddingsDir is null when overridden to null', async () => {
    clearEnv()
    const cfg = await loadConfig({ overrides: { embeddingsDir: null } })
    assert.equal(cfg.embeddingsDir, null)
  })

  test('label override wins', async () => {
    clearEnv()
    const cfg = await loadConfig({ overrides: { label: 'my-run' } })
    assert.equal(cfg.label, 'my-run')
  })

  test('label override null clears the value', async () => {
    clearEnv()
    const cfg = await loadConfig({ overrides: { label: null } })
    assert.equal(cfg.label, null)
  })

  test('label read from config file', async () => {
    clearEnv()
    const tmp = path.join(os.tmpdir(), `eval-config-label-${process.pid}.json`)
    await fs.writeFile(tmp, JSON.stringify({ label: 'from-file' }))
    try {
      const cfg = await loadConfig({ configPath: tmp })
      assert.equal(cfg.label, 'from-file')
    } finally {
      await fs.unlink(tmp)
    }
  })

  test('label override wins over config file', async () => {
    clearEnv()
    const tmp = path.join(os.tmpdir(), `eval-config-label2-${process.pid}.json`)
    await fs.writeFile(tmp, JSON.stringify({ label: 'from-file' }))
    try {
      const cfg = await loadConfig({ configPath: tmp, overrides: { label: 'override' } })
      assert.equal(cfg.label, 'override')
    } finally {
      await fs.unlink(tmp)
    }
  })
})
