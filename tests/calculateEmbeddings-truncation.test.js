import { test, after } from 'node:test'
import assert from 'node:assert'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createEmbeddings } from '../lib/calculateEmbeddings.js'

// Model max window for sentence-transformers/all-MiniLM-L6-v2 is 512 tokens
// (BERT-style). One English word ≈ 1-2 WordPiece tokens, so ~10000 words of
// "banana" is comfortably past the window.
const LONG = 'banana '.repeat(10000).trim()
const SHORT = 'banana'

let testPassed = false
after(() => { if (testPassed) process.exit(0) })

test('too-long chunk produces exactly one row, truncated not split', async () => {
  const dir = path.join(os.tmpdir(), 'embed-truncation-test-' + Date.now())
  const result = await createEmbeddings('code-chunks', [SHORT, LONG], dir)

  // Only two rows in and two rows out — no auto-split.
  assert.strictEqual(result.count, 2, 'input rows == output rows (no splitting)')
  const { readFile } = await import('node:fs/promises')
  const meta = JSON.parse(await readFile(path.join(result.outDir, 'code-chunks.json'), 'utf8'))
  assert.strictEqual(meta.chunks.length, 2, 'input rows == output rows (no splitting)')

  await unlink(path.join(result.outDir, 'code-chunks.bin'))
  await unlink(path.join(result.outDir, 'code-chunks.json'))

  testPassed = true
})
