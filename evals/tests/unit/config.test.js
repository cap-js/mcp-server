import { test, describe, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, METRIC_KEYS } from '../../lib/config.js'

const EVAL_ENV = ['EVAL_LABEL']
function clearEnv() {
  for (const k of EVAL_ENV) delete process.env[k]
}

describe('config', () => {
  afterEach(clearEnv)

  test('should load default values for k, gates, and file paths', async () => {
    const cfg = await loadConfig()

    assert.equal(cfg.k, 5)
    assert.equal(cfg.gates.recall_at_k, 0.8)
    assert.ok(cfg.goldenSet.endsWith('data/golden-set.json'))
    assert.ok(cfg.output.runsDir.endsWith('runs'))
    assert.ok(typeof cfg.embeddingsDir === 'string')
    for (const key of METRIC_KEYS) assert.ok(key in cfg.gates)
  })

  test('should apply programmatic overrides over file-based config', async () => {
    const cfg = await loadConfig({ overrides: { k: 3, gates: { recall_at_k: 0.99 }, output: { keepRuns: 3, compareFormat: 'md' } } })

    assert.equal(cfg.k, 3)
    assert.equal(cfg.gates.recall_at_k, 0.99)
    assert.equal(cfg.output.keepRuns, 3)
    assert.equal(cfg.output.compareFormat, 'md')
  })

  test('should default compareFormat to html', async () => {
    const cfg = await loadConfig()

    assert.equal(cfg.output.compareFormat, 'html')
  })

  test('should reject an invalid compareFormat value', async () => {
    await assert.rejects(
      () => loadConfig({ overrides: { output: { compareFormat: 'pdf' } } }),
      /compareFormat must be "html" or "md"/
    )
  })

  test('should reject k when it is not a positive integer', async () => {
    await assert.rejects(
      () => loadConfig({ overrides: { k: 0 } }),
      /k must be a positive integer/
    )
  })

  test('should reject a gate value outside [0,1]', async () => {
    await assert.rejects(
      () => loadConfig({ overrides: { gates: { recall_at_k: 1.5 } } }),
      /must be null or a number in \[0,1\]/
    )
  })

  test('should reject keepRuns of 0', async () => {
    await assert.rejects(
      () => loadConfig({ overrides: { output: { keepRuns: 0 } } }),
      /keepRuns must be -1 .* or a positive integer/
    )
  })

  test('should reject a fractional keepRuns value', async () => {
    await assert.rejects(
      () => loadConfig({ overrides: { output: { keepRuns: 1.5 } } }),
      /keepRuns must be -1/
    )
  })

  test('should accept keepRuns of -1', async () => {
    const cfg = await loadConfig({ overrides: { output: { keepRuns: -1 } } })

    assert.equal(cfg.output.keepRuns, -1)
  })

  test('should accept an absolute path for embeddingsDir when overridden', async () => {
    const cfg = await loadConfig({ overrides: { embeddingsDir: '/abs/sweep' } })

    assert.equal(cfg.embeddingsDir, '/abs/sweep')
  })

  test('should set embeddingsDir to null when overridden with null', async () => {
    const cfg = await loadConfig({ overrides: { embeddingsDir: null } })

    assert.equal(cfg.embeddingsDir, null)
  })

  test('should reflect a label override in the loaded config', async () => {
    const cfg = await loadConfig({ overrides: { label: 'my-run' } })

    assert.equal(cfg.label, 'my-run')
  })

  test('should clear the label when overridden with null', async () => {
    const cfg = await loadConfig({ overrides: { label: null } })

    assert.equal(cfg.label, null)
  })

  describe('when label is configured in a file', () => {
    let dir, tmp
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-config-label-'))
      tmp = path.join(dir, 'config.json')
      await fs.writeFile(tmp, JSON.stringify({ label: 'from-file' }))
    })
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    test('should read the label from the config file', async () => {
      const cfg = await loadConfig({ configPath: tmp })

      assert.equal(cfg.label, 'from-file')
    })

    test('should use the override label over the config file label', async () => {
      const cfg = await loadConfig({ configPath: tmp, overrides: { label: 'override' } })

      assert.equal(cfg.label, 'override')
    })
  })

  describe('side-effects', () => {
    test('should not mutate the overrides object passed to loadConfig', async () => {
      const overrides = { k: 3, gates: { recall_at_k: 0.9 } }
      const keysBefore = Object.keys(overrides)

      await loadConfig({ overrides })

      assert.deepEqual(Object.keys(overrides), keysBefore)
    })
  })
})
