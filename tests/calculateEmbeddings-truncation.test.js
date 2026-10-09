import { test, describe, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import fsp from 'node:fs/promises'
import os from 'node:os'
import calculateEmbeddings, { createEmbeddings, getActiveEmbeddingsDir, setEmbeddingsDir } from '../lib/calculateEmbeddings.js'
import { discoverModel } from '@cap-js/ai/lib/vector_embedding/model-discovery.js'

// Model max window for sentence-transformers/all-MiniLM-L6-v2 is 512 tokens
// (BERT-style). One English word ≈ 1-2 WordPiece tokens, so ~10000 words of
// "banana" is comfortably past the window.
const LONG = 'banana '.repeat(10000).trim()
const SHORT = 'banana'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'calculateEmbeddings-truncation-'))
setEmbeddingsDir(tmpDir)

after(async () => {
  setEmbeddingsDir()
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('createEmbeddings truncation', () => {
  beforeEach(async () => {
    const dir = getActiveEmbeddingsDir()
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    await fsp.mkdir(dir, { recursive: true })
  })
  afterEach(() => mock.restoreAll())

  test('too-long chunk produces exactly one row, truncated not split', async () => {
    // Writes go to real tmp dir; the real embedder still reads its model from disk.
    const result = await createEmbeddings('code-chunks', [SHORT, LONG])

    // Only two rows in and two rows out — no auto-split.
    assert.strictEqual(result.count, 2, 'input rows == output rows (no splitting)')
    const meta = JSON.parse(await fsp.readFile(path.join(result.outDir, 'code-chunks.json'), 'utf-8'))
    assert.strictEqual(meta.chunks.length, 2, 'input rows == output rows (no splitting)')
  })
})

// Common English words that encode to a single token each, so word count maps
// closely to the model's token budget.
const VOCAB = ['the', 'cat', 'sat', 'on', 'mat', 'dog', 'ran', 'far', 'and',
               'but', 'not', 'yet', 'now', 'for', 'nor', 'so', 'or', 'as', 'at', 'by']
const words = n => Array.from({ length: n }, (_, i) => VOCAB[i % VOCAB.length]).join(' ')
const embEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

describe('embedding truncation position', () => {
  test('binary-searches the word count at which the active model truncates', async () => {
    const model = 'BAAI/bge-small-en-v1.5'
    const { maxLength } = await discoverModel(model)

    // Each VOCAB word ≈ 1 token, so maxLength words fills the window.
    // Add 200 words of margin so the ceiling is safely past truncation.
    const CEILING = maxLength + 200
    const ceilEmb = await calculateEmbeddings(words(CEILING), model)

    let lo = 1        // not yet truncated
    let hi = CEILING  // already truncated
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      const midEmb = await calculateEmbeddings(words(mid), model)
      if (embEq(midEmb, ceilEmb)) hi = mid
      else lo = mid
    }

    // eslint-disable-next-line no-console
    console.log(`\n${model}\n  maxLength ${maxLength} tokens → truncates at word #${hi} (${words(hi).length} chars); last unique at word #${lo}\n`)

    // A real boundary must sit below the ceiling, otherwise CEILING was too small.
    assert.ok(hi < CEILING, `no truncation found below CEILING=${CEILING}; raise it for model ${model}`)
  })
})
