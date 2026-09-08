import { test, describe, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import fs from 'fs/promises'

process.env.CDS_MCP_OFFLINE = 'true'

const { downloadEmbeddings, resolveLocalVersion } = await import('../lib/searchMarkdownDocs.js')
const { DEFAULT_DIR, DEFAULT_EMBEDDINGS_DIR, MODEL_FOLDER } = await import('../lib/calculateEmbeddings.js')
const cds = (await import('@sap/cds')).default

const originalFetch = globalThis.fetch
const manifestEtagPath = path.join(DEFAULT_DIR, 'manifest.etag')

async function clearBundleState() {
  await fs.rm(manifestEtagPath, { force: true }).catch(() => {})
}

function stubBundle({ version = '__test_bundle__', body = { dim: 0, count: 0, chunks: [] }, bin = 'BIN' } = {}) {
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {} })
    return new Response(JSON.stringify({ ...body, embeddings: Buffer.from(bin).toString('base64') }), {
      status: 200,
      headers: { etag: 'W/"seed"', 'x-embeddings-version': version }
    })
  }
  return seen
}

describe('downloadEmbeddings (bundle endpoint)', () => {
  const testVer = '__test_bundle__'
  const testDir = path.join(DEFAULT_EMBEDDINGS_DIR, testVer)

  beforeEach(async () => {
    globalThis.fetch = originalFetch
    await clearBundleState()
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })
  after(async () => {
    globalThis.fetch = originalFetch
    await clearBundleState()
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  test('sends cds and model query params', async () => {
    const seen = stubBundle({ version: testVer })
    await downloadEmbeddings()
    const url = new URL(seen[0].url)
    assert.strictEqual(url.pathname.endsWith('/getEmbeddings'), true)
    assert.strictEqual(url.searchParams.get('cds'), cds.version)
    assert.strictEqual(url.searchParams.get('model'), MODEL_FOLDER)
  })

  test('writes versioned json + bin and returns updated=true', async () => {
    stubBundle({ version: testVer, body: { dim: 1, count: 1, chunks: ['hi'] }, bin: 'BYTES' })
    const r = await downloadEmbeddings()
    assert.strictEqual(r.updated, true)
    assert.strictEqual(r.version, testVer)

    const meta = JSON.parse(await fs.readFile(path.join(testDir, 'code-chunks.json'), 'utf-8'))
    assert.deepStrictEqual(meta.chunks, ['hi'])
    assert.strictEqual(meta.embeddings, undefined, 'embeddings field must be stripped from meta json')

    const bin = await fs.readFile(path.join(testDir, 'code-chunks.bin'))
    assert.strictEqual(bin.toString(), 'BYTES')
  })

  test('persists etag, sends If-None-Match on next call, 304 → resolveLocalVersion fallback', async () => {
    stubBundle({ version: testVer })
    await downloadEmbeddings()
    const savedEtag = (await fs.readFile(manifestEtagPath, 'utf-8')).trim()
    assert.strictEqual(savedEtag, 'W/"seed"')

    let condHeader = null
    globalThis.fetch = async (url, init = {}) => {
      condHeader = init.headers?.['If-None-Match']
      return new Response(null, { status: 304 })
    }
    const r = await downloadEmbeddings()
    assert.strictEqual(condHeader, 'W/"seed"')
    assert.strictEqual(r.updated, false)
    // First call wrote the versioned dir; resolveLocalVersion should surface it.
    assert.ok(r.version, 'returns some version from local dir')
  })

  test('throws when bundle 304 but no local versioned embeddings exist', async () => {
    await fs.writeFile(manifestEtagPath, 'W/"orphan"')
    // Ensure no local versioned dirs exist under DEFAULT_EMBEDDINGS_DIR.
    const entries = await fs.readdir(DEFAULT_EMBEDDINGS_DIR, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.isDirectory()) await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, e.name), { recursive: true, force: true }).catch(() => {})
    }
    globalThis.fetch = async () => new Response(null, { status: 304 })
    await assert.rejects(downloadEmbeddings(), /no local versioned embeddings found/)
  })

  test('throws when bundle response is non-OK', async () => {
    globalThis.fetch = async () => new Response(null, { status: 500, statusText: 'Server Err' })
    await assert.rejects(downloadEmbeddings(), /Failed to fetch bundle: 500/)
  })

  test('throws when bundle response lacks X-Embeddings-Version header', async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ dim: 0, count: 0, chunks: [], embeddings: Buffer.from('X').toString('base64') }),
      { status: 200, headers: { etag: 'W/"x"' } }
    )
    await assert.rejects(downloadEmbeddings(), /missing X-Embeddings-Version/)
  })

  test('throws when bundle response lacks embeddings field', async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ dim: 0, count: 0, chunks: [] }),
      { status: 200, headers: { 'x-embeddings-version': testVer } }
    )
    await assert.rejects(downloadEmbeddings(), /missing embeddings/)
  })

  test('propagates fetch network error', async () => {
    globalThis.fetch = async () => { throw new TypeError('network down') }
    await assert.rejects(downloadEmbeddings(), /network down/)
  })
})

describe('resolveLocalVersion', () => {
  const testVersions = ['__local_1.0.0__', '__local_2.5.0__', '__local_2.10.0__', '__incomplete__']

  beforeEach(async () => {
    const entries = await fs.readdir(DEFAULT_EMBEDDINGS_DIR, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.isDirectory()) await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, e.name), { recursive: true, force: true }).catch(() => {})
    }
  })

  after(async () => {
    for (const v of testVersions) await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, v), { recursive: true, force: true }).catch(() => {})
  })

  test('returns a version with both files and skips incomplete dirs', async () => {
    for (const v of ['__local_1.0.0__', '__local_2.5.0__', '__local_2.10.0__']) {
      const dir = path.join(DEFAULT_EMBEDDINGS_DIR, v)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'code-chunks.json'), '{}')
      await fs.writeFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))
    }
    const incompleteDir = path.join(DEFAULT_EMBEDDINGS_DIR, '__incomplete__')
    await fs.mkdir(incompleteDir, { recursive: true })
    await fs.writeFile(path.join(incompleteDir, 'code-chunks.json'), '{}')

    const local = await resolveLocalVersion()
    assert.ok(local)
    assert.strictEqual(local.localDir, path.join(DEFAULT_EMBEDDINGS_DIR, local.version))
    assert.notStrictEqual(local.version, '__incomplete__')
    const [j, b] = await Promise.all([
      fs.access(path.join(local.localDir, 'code-chunks.json')).then(() => true).catch(() => false),
      fs.access(path.join(local.localDir, 'code-chunks.bin')).then(() => true).catch(() => false)
    ])
    assert.ok(j && b)
  })

  test('among two seeded siblings, returns the higher one', async () => {
    const low = '__local_1.0.0__'
    const high = '__local_2.10.0__'
    for (const v of [low, high]) {
      const dir = path.join(DEFAULT_EMBEDDINGS_DIR, v)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'code-chunks.json'), '{}')
      await fs.writeFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))
    }
    const local = await resolveLocalVersion()
    assert.strictEqual(local.version, high)
  })
})
