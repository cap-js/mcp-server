import { test, describe } from 'node:test'
import assert from 'node:assert'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import searchMarkdownDocs from '../lib/searchMarkdownDocs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EMBEDDINGS_DIR = path.join(__dirname, '..', 'embeddings')

describe('searchMarkdownDocs integration tests', () => {
  test('should download and load embeddings from server', async () => {
    // This test verifies the full download and search functionality
    const result = await searchMarkdownDocs('entity definition', 3)

    assert(typeof result === 'string', 'Result should be a string')
    assert(result.length > 0, 'Result should not be empty')
    assert(result.includes('---'), 'Result should contain separators between chunks')

    // Verify files were created
    const jsonExists = await fs
      .access(path.join(EMBEDDINGS_DIR, 'code-chunks.json'))
      .then(() => true)
      .catch(() => false)
    const binExists = await fs
      .access(path.join(EMBEDDINGS_DIR, 'code-chunks.bin'))
      .then(() => true)
      .catch(() => false)

    assert(jsonExists, 'JSON metadata file should exist after download')
    assert(binExists, 'Binary embeddings file should exist after download')
  })

  test('should handle search queries and return relevant results', async () => {
    const queries = ['entity definition', 'service implementation', 'authentication', 'database schema']

    for (const query of queries) {
      const result = await searchMarkdownDocs(query, 2)
      assert(typeof result === 'string', `Result for "${query}" should be a string`)
      assert(result.length > 0, `Result for "${query}" should not be empty`)

      // Should contain at most 2 chunks (plus separators)
      const chunks = result.split('\n---\n')
      assert(chunks.length <= 2, `Should return at most 2 chunks for "${query}"`)
    }
  })

  test('should use embeddings files consistently', async () => {
    // Get file stats before making calls
    const jsonPath = path.join(EMBEDDINGS_DIR, 'code-chunks.json')
    const binPath = path.join(EMBEDDINGS_DIR, 'code-chunks.bin')

    // Ensure files exist first
    await searchMarkdownDocs('test', 1)

    const jsonStatBefore = await fs.stat(jsonPath)
    const binStatBefore = await fs.stat(binPath)

    // Make several calls
    const result1 = await searchMarkdownDocs('entity', 1)
    const result2 = await searchMarkdownDocs('service', 1)

    // Check that files weren't modified (using cached files)
    const jsonStatAfter = await fs.stat(jsonPath)
    const binStatAfter = await fs.stat(binPath)

    assert(typeof result1 === 'string', 'First result should be a string')
    assert(typeof result2 === 'string', 'Second result should be a string')
    assert(result1.length > 0, 'First result should not be empty')
    assert(result2.length > 0, 'Second result should not be empty')

    // Files should have same modification time (not re-downloaded)
    assert.strictEqual(
      jsonStatBefore.mtime.getTime(),
      jsonStatAfter.mtime.getTime(),
      'JSON file should not be re-downloaded'
    )
    assert.strictEqual(
      binStatBefore.mtime.getTime(),
      binStatAfter.mtime.getTime(),
      'Binary file should not be re-downloaded'
    )
  })
  test('should reuse downloaded files on subsequent calls', async () => {
    // First call - downloads embeddings
    const result1 = await searchMarkdownDocs('entity', 1)

    // Verify files exist
    const jsonExists = await fs
      .access(path.join(EMBEDDINGS_DIR, 'code-chunks.json'))
      .then(() => true)
      .catch(() => false)
    const binExists = await fs
      .access(path.join(EMBEDDINGS_DIR, 'code-chunks.bin'))
      .then(() => true)
      .catch(() => false)

    assert(jsonExists, 'JSON file should exist')
    assert(binExists, 'Binary file should exist')

    // Second call - should use existing files
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
