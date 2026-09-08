import { test, describe, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import fs from 'fs/promises'

// Do NOT set OFFLINE — this test exercises the real end-to-end download flow
// against the local static server started by the session.
const { downloadEmbeddings, default: searchMarkdownDocs } = await import('../lib/searchMarkdownDocs.js')
const { DEFAULT_EMBEDDINGS_DIR, MODEL_FOLDER } = await import('../lib/calculateEmbeddings.js')
const cds = (await import('@sap/cds')).default

const originalFetch = globalThis.fetch

describe('downloadEmbeddings (versioned layout)', () => {
  test('module-load download completes and writes into versioned subdir', async () => {
    await searchMarkdownDocs('warmup', 1)
    const result = await downloadEmbeddings()
    assert.ok(result.version, 'version returned')
    assert.strictEqual(result.updated, false, 'cached on second call')
    const jsonPath = path.join(DEFAULT_EMBEDDINGS_DIR, result.version, 'code-chunks.json')
    const binPath = path.join(DEFAULT_EMBEDDINGS_DIR, result.version, 'code-chunks.bin')
    const [j, b] = await Promise.all([
      fs.access(jsonPath).then(() => true).catch(() => false),
      fs.access(binPath).then(() => true).catch(() => false)
    ])
    assert.ok(j, 'code-chunks.json exists under version dir')
    assert.ok(b, 'code-chunks.bin exists under version dir')
  })

  test('subsequent call reports updated=false', async () => {
    const result = await downloadEmbeddings()
    assert.strictEqual(result.updated, false)
    assert.ok(result.version)
  })

  test('searchMarkdownDocs returns non-empty string using versioned dir', async () => {
    const out = await searchMarkdownDocs('entity definition', 2)
    assert.strictEqual(typeof out, 'string')
    assert.ok(out.length > 0)
  })
})

describe('downloadEmbeddings error cases', () => {
  afterEach(() => { globalThis.fetch = originalFetch })
  after(() => { globalThis.fetch = originalFetch })

  test('throws when no suitable version is found', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/versions.json')) {
        return new Response(JSON.stringify({ [MODEL_FOLDER]: [{ version: '1.0.0', cdsDevDependency: '>=999' }] }), { status: 200 })
      }
      return new Response(null, { status: 404 })
    }
    await assert.rejects(
      downloadEmbeddings(),
      /No suitable embeddings version found/
    )
  })

  test('throws when manifest fetch returns non-OK', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/versions.json')) return new Response(null, { status: 500 })
      return new Response(null, { status: 404 })
    }
    await assert.rejects(
      downloadEmbeddings(),
      /No suitable embeddings version found/
    )
  })

  test('throws when JSON download returns non-OK', async () => {
    const tmpVer = '__test_download_json_fail__'
    globalThis.fetch = async (url) => {
      const s = String(url)
      if (s.endsWith('/versions.json')) {
        return new Response(JSON.stringify({ [MODEL_FOLDER]: [{ version: tmpVer, cdsDevDependency: `>=${major(cds.version)}` }] }), { status: 200 })
      }
      if (s.endsWith('/code-chunks.json')) return new Response(null, { status: 404, statusText: 'Not Found' })
      return new Response(null, { status: 404 })
    }
    await assert.rejects(
      downloadEmbeddings(),
      /Failed to download JSON: 404/
    )
  })

  test('throws when BIN download returns non-OK', async () => {
    const tmpVer = '__test_download_bin_fail__'
    globalThis.fetch = async (url) => {
      const s = String(url)
      if (s.endsWith('/versions.json')) {
        return new Response(JSON.stringify({ [MODEL_FOLDER]: [{ version: tmpVer, cdsDevDependency: `>=${major(cds.version)}` }] }), { status: 200 })
      }
      if (s.endsWith('/code-chunks.json')) return new Response('{}', { status: 200 })
      if (s.endsWith('/code-chunks.bin')) return new Response(null, { status: 500, statusText: 'Server Error' })
      return new Response(null, { status: 404 })
    }
    await assert.rejects(
      downloadEmbeddings(),
      /Failed to download BIN: 500/
    )
  })

  test('propagates fetch network error', async () => {
    globalThis.fetch = async () => { throw new TypeError('network down') }
    await assert.rejects(downloadEmbeddings(), /network down/)
  })
})

function major(v) {
  return parseInt(String(v).split('.')[0], 10)
}
