import { test } from 'node:test'
import assert from 'node:assert'
import { getEmbeddings } from '../lib/embeddings.js'

test.describe('embeddings', () => {
  test('should create embeddings for a test string', async () => {
    const results = await getEmbeddings('Node.js testing')
    assert(results.length, 'Results should be an array')
  })
})
