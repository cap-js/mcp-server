import { test, describe, after } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { buildTestBundle } from './helpers/test-bundle.js'

// Offline mode must be set BEFORE the module reads it at import.
process.env.CDS_MCP_OFFLINE = 'true'

const { default: searchMarkdownDocs } = await import('../lib/searchMarkdownDocs.js')
const { setEmbeddingsDir } = await import('../lib/calculateEmbeddings.js')

// Point the default dir at an empty dir so no local version resolves.
const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-empty-'))
setEmbeddingsDir(emptyDir)

const overrideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-override-'))

after(async () => {
  setEmbeddingsDir()
  delete process.env.CDS_MCP_EMBEDDINGS_DIR
  await fs.rm(emptyDir, { recursive: true, force: true }).catch(() => {})
  await fs.rm(overrideDir, { recursive: true, force: true }).catch(() => {})
})

describe('offline CDS_MCP_EMBEDDINGS_DIR override', () => {
  test('without override, an empty default dir rejects with the offline error', async () => {
    delete process.env.CDS_MCP_EMBEDDINGS_DIR
    await assert.rejects(() => searchMarkdownDocs('cds init', 1), /no local embeddings version/i)
  })

  test('with override, offline search uses the given leaf dir', async () => {
    // Materialize a valid bundle (server frame → code-chunks.json/.bin) in the override dir.
    const frame = await buildTestBundle()
    const metaLen = frame.readUInt32BE(0)
    await fs.writeFile(path.join(overrideDir, 'code-chunks.json'), frame.subarray(4, 4 + metaLen))
    await fs.writeFile(path.join(overrideDir, 'code-chunks.bin'), frame.subarray(4 + metaLen))

    process.env.CDS_MCP_EMBEDDINGS_DIR = overrideDir
    const result = await searchMarkdownDocs('cds init', 1)
    assert(typeof result === 'string' && result.length > 0, 'Override dir should return results')
  })
})
