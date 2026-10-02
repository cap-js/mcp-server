import { test, describe, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import os from 'node:os'
import { installMemFs } from './helpers/mem-fs-mock.js'
import { createEmbeddings } from '../lib/calculateEmbeddings.js'

// Model max window for sentence-transformers/all-MiniLM-L6-v2 is 512 tokens
// (BERT-style). One English word ≈ 1-2 WordPiece tokens, so ~10000 words of
// "banana" is comfortably past the window.
const LONG = 'banana '.repeat(10000).trim()
const SHORT = 'banana'

let testPassed = false
after(() => {
  if (testPassed) process.exit(0)
})

describe('createEmbeddings truncation', () => {
  let mem
  beforeEach(() => {
    mem = installMemFs()
  })
  afterEach(() => mock.restoreAll())

  test('too-long chunk produces exactly one row, truncated not split', async () => {
    // Writes stay in memory; the real embedder still reads its model from disk.
    const dir = path.join(os.tmpdir(), 'embed-truncation-test-' + Date.now())
    const result = await createEmbeddings('code-chunks', [SHORT, LONG], dir)

    // Only two rows in and two rows out — no auto-split.
    assert.strictEqual(result.count, 2, 'input rows == output rows (no splitting)')
    const meta = mem.readJson(path.join(result.outDir, 'code-chunks.json'))
    assert.strictEqual(meta.chunks.length, 2, 'input rows == output rows (no splitting)')

    testPassed = true
  })
})
