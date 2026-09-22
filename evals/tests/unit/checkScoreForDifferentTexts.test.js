import { test } from 'node:test'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createEmbeddings } from '../../../lib/calculateEmbeddings.js'
import { getEmbeddings, loadChunks } from '../../../lib/embeddings.js'

// just used for testing scoring of different embedded texts
test.skip('check test', async () => {
  const text1 = `### . keys
### . associations
### . compositions
### . actions

These properties are convenient shortcuts to access an entity definition's declared *keys* (/docs/cds/cdl#entities), *Association (/docs/cds/cdl#associations)* or *Composition (/docs/cds/cdl#associations)* elements, as well as *bound action* or *function* (/docs/cds/cdl#bound-actions) definitions.
Their values are [\`LinkedDefinitions\`].
CDS entity definition data model CDS action operation mutation CDS function query operation`
  const text2 = `### . keys
### . associations
### . compositions
### . actions

These properties are convenient shortcuts to access an entity definition's declared *keys* (/docs/cds/cdl#entities), *Association (/docs/cds/cdl#associations)* or *Composition (/docs/cds/cdl#associations)* elements, as well as *bound action* or *function* (/docs/cds/cdl#bound-actions) definitions.
Their values are [\`LinkedDefinitions\`].`
  const dir = path.join(os.tmpdir(), 'embed-truncation-test-' + Date.now())
  const resultEmbeddings = await createEmbeddings('code-chunks', [text1, text2], dir)

  const query = 'What are the convenient shortcuts for accessing entity definitions in CAP?'
  const search = await getEmbeddings(query)
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

  const isFirst = scoredChunks[0].content == text1
  console.log(`\ntext${isFirst ? '1' : '2'}: ${scoredChunks[0].similarity}`)
  console.log(`text${isFirst ? '2' : '1'}: ${scoredChunks[1].similarity}\n\n`)
  
  await unlink(path.join(resultEmbeddings.outDir, 'code-chunks.bin'))
  await unlink(path.join(resultEmbeddings.outDir, 'code-chunks.json'))
})
