import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { readRuns, resultsPath } from '../../lib/store.js'

const cfg = dir => ({ output: { runsDir: dir, resultsName: 'result.jsonl' } })

describe('store', () => {
  let tmpDir
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-store-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('should return an empty array when the results file does not exist', async () => {
    const result = await readRuns(cfg(tmpDir))

    assert.deepEqual(result, [])
  })

  test('should rethrow errors that are not ENOENT', async () => {
    await fs.mkdir(resultsPath(cfg(tmpDir)))

    await assert.rejects(
      () => readRuns(cfg(tmpDir)),
      /EISDIR/
    )
  })

  describe('side-effects', () => {
    test('should not mutate the config object passed to readRuns', async () => {
      const config = cfg(tmpDir)
      const keysBefore = Object.keys(config)

      await readRuns(config)

      assert.deepEqual(Object.keys(config), keysBefore)
    })
  })
})
