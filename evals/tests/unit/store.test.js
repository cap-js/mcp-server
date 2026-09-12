import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { readRuns, resultsPath } from '../../lib/store.js'

const cfg = dir => ({ paths: { runsDir: dir }, output: { resultsName: 'result.jsonl' } })

describe('store tests', () => {
  let tmpDir
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-store-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('readRuns returns [] when the results file does not exist (ENOENT)', async () => {
    assert.deepEqual(await readRuns(cfg(tmpDir)), [])
  })

  test('readRuns rethrows a non-ENOENT read error', async () => {
    // Make resultsPath a directory → reading it fails with EISDIR, not ENOENT.
    await fs.mkdir(resultsPath(cfg(tmpDir)))
    await assert.rejects(() => readRuns(cfg(tmpDir)), err => err.code !== 'ENOENT')
  })
})
