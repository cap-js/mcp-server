// Tests for progress logging in createEmbeddings (lib/embeddings.js).
//
// Run: node --test tests/embedding-progress.test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createEmbeddings } from '../lib/embeddings.js'

const CHUNKS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon',
                'zeta', 'eta', 'theta', 'iota', 'kappa']  // 10 chunks

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'emb-progress-'))
}

async function captureLog(fn) {
  const lines = []
  const orig = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try { await fn() } finally { console.log = orig }
  return lines
}

test('progress fires every LOG_EVERY chunks and always on the last chunk', async () => {
  const dir = await tmpDir()
  process.env.EMBEDDINGS_LOG_EVERY = '3' // fires at 3, 6, 9, 10

  const lines = await captureLog(() => createEmbeddings('code-chunks', CHUNKS, dir))

  delete process.env.EMBEDDINGS_LOG_EVERY
  await fs.rm(dir, { recursive: true, force: true })

  const progress = lines.filter(l => /^Embedding \d+\/\d+/.test(l))
  assert.ok(progress.length >= 3, `expected at least 3 progress lines, got ${progress.length}`)
  const last = progress[progress.length - 1]
  assert.ok(last.includes('10/10'), `last line should be 10/10, got: ${last}`)
  assert.ok(last.includes('100%'), `last line should show 100%, got: ${last}`)
})

test('progress line contains elapsed time and ETA', async () => {
  const dir = await tmpDir()
  process.env.EMBEDDINGS_LOG_EVERY = '5'
  const lines = await captureLog(() => createEmbeddings('code-chunks', CHUNKS, dir))
  delete process.env.EMBEDDINGS_LOG_EVERY
  await fs.rm(dir, { recursive: true, force: true })

  const progress = lines.filter(l => /^Embedding \d+\/\d+/.test(l))
  assert.ok(progress.length > 0, 'expected at least one progress line')
  assert.ok(progress[0].includes('elapsed'), `should contain "elapsed": ${progress[0]}`)
  assert.ok(progress[0].includes('remaining'), `should contain "remaining": ${progress[0]}`)
})

test('EMBEDDINGS_LOG_EVERY=0 suppresses all progress output', async () => {
  const dir = await tmpDir()
  process.env.EMBEDDINGS_LOG_EVERY = '0'
  const lines = await captureLog(() => createEmbeddings('code-chunks', CHUNKS, dir))
  delete process.env.EMBEDDINGS_LOG_EVERY
  await fs.rm(dir, { recursive: true, force: true })

  const progress = lines.filter(l => /^Embedding \d+\/\d+/.test(l))
  assert.equal(progress.length, 0, `expected no progress lines, got: ${progress.join(' | ')}`)
})
