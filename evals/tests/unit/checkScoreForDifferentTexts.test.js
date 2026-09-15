import { test } from 'node:test'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createEmbeddings } from '../../../lib/calculateEmbeddings.js'
import { getEmbeddings, loadChunks } from '../../../lib/embeddings.js'

// just used for testing scoring of different embedded texts
test('check test', async () => {
  const text1 = "## Databases\n\n###### Inner Loop\n\n> [!tip] Inner-Loop Development\n> SQLite isn't meant for productive use, but rather for development only.\n> It drastically speeds up turn-around times in local inner-loop development.\n> Essentially it acts as a mock stand-in for the target databases we'll use in production, that is, SAP HANA."
  const text2 = "# The CAP Cookbook\n\nRecipes for CAP Development\n\nThe following figure illustrates a walkthrough of the most prominent tasks during development of CAP-based projects. The guides contained in this section provide details and instructions about each.\n\nDomain Modeling (/docs/guides/domain/index)\n : Most projects start with capturing the essential objects of their domain in a respective domain model. Find here an introduction to the basics of domain modeling with CDS, complemented with recommended best practices."
  const dir = path.join(os.tmpdir(), 'embed-truncation-test-' + Date.now())
  const resultEmbeddings = await createEmbeddings('code-chunks', [text1, text2], dir)

  const search = await getEmbeddings('How does cds watch react when I save a domain model and what is the inner development loop in CAP?', 'Xenova/all-MiniLM-L6-v2')
  const chunks = await loadChunks('code-chunks', resultEmbeddings.outDir)

  function cosineSimilarity(a, b) {
    const dot = a.reduce((sum, val, i) => sum + val * b[i], 0)
    const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
    const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
    return dot / (normA * normB)
  }
  const scoredChunks = chunks.map(chunk => ({
    ...chunk,
    similarity: cosineSimilarity(search, chunk.embeddings)
  }))
  // Sort by similarity descending
  scoredChunks.sort((a, b) => b.similarity - a.similarity)
  
  await unlink(path.join(resultEmbeddings.outDir, 'code-chunks.bin'))
  await unlink(path.join(resultEmbeddings.outDir, 'code-chunks.json'))
})
