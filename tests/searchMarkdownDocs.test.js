import { fileURLToPath } from 'url'
import path from 'path'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

import { test, describe } from 'node:test'
import assert from 'node:assert'
import fs from 'fs/promises'

const embeddingsDir = path.join(__dirname, '..', 'embeddings')

// Use dynamic import to ensure environment variable is set before module evaluation
const searchMarkdownDocs = (await import('../lib/searchMarkdownDocs.js')).default

describe('searchMarkdownDocs integration tests', () => {
  test('should load and search existing embeddings', async () => {
    // This test verifies the search functionality with existing embeddings
    const result = await searchMarkdownDocs('entity definition', 3)

    assert(typeof result === 'string', 'Result should be a string')
    assert(result.length > 0, 'Result should not be empty')
    assert(result.includes('---'), 'Result should contain separators between chunks')
  })

  test('should handle search queries and return relevant results', async () => {
    const queries = ['entity definition', 'service implementation', 'authentication', 'database schema']

    for (const query of queries) {
      const result = await searchMarkdownDocs(query, 2)
      assert(typeof result === 'string', `Result for "${query}" should be a string`)
      assert(result.length > 0, `Result for "${query}" should not be empty`)

      const chunks = result.split('\n---\n')
      assert(chunks.length <= 2, `Should return at most 2 chunks for "${query}"`)
    }
  })

  test('should use embeddings files consistently', async () => {
    // Get file stats before making calls
    const jsonPath = path.join(embeddingsDir, 'code-chunks.json')
    const binPath = path.join(embeddingsDir, 'code-chunks.bin')

    const jsonStatBefore = await fs.stat(jsonPath)
    const binStatBefore = await fs.stat(binPath)

    // Make several calls
    const result1 = await searchMarkdownDocs('entity', 1)
    const result2 = await searchMarkdownDocs('service', 1)

    // Check that files weren't modified (using existing files)
    const jsonStatAfter = await fs.stat(jsonPath)
    const binStatAfter = await fs.stat(binPath)

    assert(typeof result1 === 'string', 'First result should be a string')
    assert(typeof result2 === 'string', 'Second result should be a string')
    assert(result1.length > 0, 'First result should not be empty')
    assert(result2.length > 0, 'Second result should not be empty')

    // Files should have same modification time (not modified)
    assert.strictEqual(
      jsonStatBefore.mtime.getTime(),
      jsonStatAfter.mtime.getTime(),
      'JSON file should not be modified'
    )
    assert.strictEqual(
      binStatBefore.mtime.getTime(),
      binStatAfter.mtime.getTime(),
      'Binary file should not be modified'
    )
  })
  test('should work with multiple search calls', async () => {
    // First call - uses existing embeddings
    const result1 = await searchMarkdownDocs('entity', 1)

    // Second call - should use same existing files
    const result2 = await searchMarkdownDocs('service', 1)

    assert(typeof result1 === 'string', 'First result should be a string')
    assert(typeof result2 === 'string', 'Second result should be a string')
    assert(result1.length > 0, 'First result should not be empty')
    assert(result2.length > 0, 'Second result should not be empty')
  })

  test('should respect maxResults parameter', async () => {
    const maxResults = 5
    const result = await searchMarkdownDocs('entity service', maxResults)

    const chunks = result.split('\n---\n')
    assert(chunks.length <= maxResults, `Should return at most ${maxResults} chunks`)

    // Test with different maxResults values
    for (const max of [1, 3, 10]) {
      const limitedResult = await searchMarkdownDocs('cds model', max)
      const limitedChunks = limitedResult.split('\n---\n')
      assert(limitedChunks.length <= max, `Should return at most ${max} chunks`)
    }
  })
})
