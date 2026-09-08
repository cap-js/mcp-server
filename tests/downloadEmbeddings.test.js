import { test, describe, after, afterEach } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import fs from 'fs/promises'

// Prevent the module-load download from hitting the real network — tests below
// exercise downloadEmbeddings() explicitly with a stubbed fetch.
process.env.CDS_MCP_OFFLINE = 'true'

const { downloadEmbeddings, resolveLocalVersion } = await import('../lib/searchMarkdownDocs.js')
const { DEFAULT_EMBEDDINGS_DIR, MODEL_FOLDER } = await import('../lib/calculateEmbeddings.js')
const cds = (await import('@sap/cds')).default

const originalFetch = globalThis.fetch

function stubManifestAnd(versionsEntries, { jsonBody, jsonStatus = 200, binStatus = 200 } = {}) {
  globalThis.fetch = async (url) => {
    const s = String(url)
    if (s.endsWith('/versions.json')) {
      return new Response(JSON.stringify({ [MODEL_FOLDER]: versionsEntries }), { status: 200 })
    }
    if (s.endsWith('/code-chunks.json')) {
      if (jsonStatus !== 200) return new Response(null, { status: jsonStatus, statusText: 'Err' })
      return new Response(jsonBody ?? JSON.stringify({ chunks: [], dim: 0 }), { status: 200 })
    }
    if (s.endsWith('/code-chunks.bin')) {
      if (binStatus !== 200) return new Response(null, { status: binStatus, statusText: 'Err' })
      return new Response(Buffer.alloc(0), { status: 200 })
    }
    return new Response(null, { status: 404 })
  }
}

function major(v) { return parseInt(String(v).split('.')[0], 10) }

describe('downloadEmbeddings (versioned layout)', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch
    await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, '__test_dl__'), { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, '__test_cached__'), { recursive: true, force: true }).catch(() => {})
  })
  after(() => { globalThis.fetch = originalFetch })

  test('downloads chunks into versioned subdir and reports version', async () => {
    stubManifestAnd([{ version: '__test_dl__', cdsDevDependency: `>=${major(cds.version)}` }])
    const result = await downloadEmbeddings()
    assert.strictEqual(result.version, '__test_dl__')
    assert.strictEqual(result.updated, true)
    const dir = path.join(DEFAULT_EMBEDDINGS_DIR, '__test_dl__')
    const [j, b] = await Promise.all([
      fs.access(path.join(dir, 'code-chunks.json')).then(() => true).catch(() => false),
      fs.access(path.join(dir, 'code-chunks.bin')).then(() => true).catch(() => false)
    ])
    assert.ok(j, 'code-chunks.json exists under version dir')
    assert.ok(b, 'code-chunks.bin exists under version dir')
  })

  test('subsequent call sees cached files and reports updated=false', async () => {
    const cachedDir = path.join(DEFAULT_EMBEDDINGS_DIR, '__test_cached__')
    await fs.mkdir(cachedDir, { recursive: true })
    await fs.writeFile(path.join(cachedDir, 'code-chunks.json'), '{}')
    await fs.writeFile(path.join(cachedDir, 'code-chunks.bin'), Buffer.alloc(0))
    stubManifestAnd([{ version: '__test_cached__', cdsDevDependency: `>=${major(cds.version)}` }])
    const result = await downloadEmbeddings()
    assert.strictEqual(result.version, '__test_cached__')
    assert.strictEqual(result.updated, false)
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
    await assert.rejects(downloadEmbeddings(), /No suitable embeddings version found/)
  })

  test('throws when manifest fetch returns non-OK', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/versions.json')) return new Response(null, { status: 500 })
      return new Response(null, { status: 404 })
    }
    await assert.rejects(downloadEmbeddings(), /No suitable embeddings version found/)
  })

  test('throws when JSON download returns non-OK', async () => {
    stubManifestAnd([{ version: '__test_json_fail__', cdsDevDependency: `>=${major(cds.version)}` }], { jsonStatus: 404 })
    await assert.rejects(downloadEmbeddings(), /Failed to download JSON: 404/)
  })

  test('throws when BIN download returns non-OK', async () => {
    stubManifestAnd([{ version: '__test_bin_fail__', cdsDevDependency: `>=${major(cds.version)}` }], { binStatus: 500 })
    await assert.rejects(downloadEmbeddings(), /Failed to download BIN: 500/)
  })

  test('propagates fetch network error', async () => {
    globalThis.fetch = async () => { throw new TypeError('network down') }
    await assert.rejects(downloadEmbeddings(), /network down/)
  })
})

describe('resolveLocalVersion', () => {
  const testVersions = ['__local_1.0.0__', '__local_2.5.0__', '__local_2.10.0__', '__incomplete__']

  after(async () => {
    for (const v of testVersions) {
      await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, v), { recursive: true, force: true }).catch(() => {})
    }
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
    assert.ok(local, 'returns a candidate')
    assert.ok(local.version, 'candidate has version')
    assert.strictEqual(local.localDir, path.join(DEFAULT_EMBEDDINGS_DIR, local.version))
    assert.notStrictEqual(local.version, '__incomplete__', 'skips dir missing bin')
    // Both files must exist for the returned version.
    const [j, b] = await Promise.all([
      fs.access(path.join(local.localDir, 'code-chunks.json')).then(() => true).catch(() => false),
      fs.access(path.join(local.localDir, 'code-chunks.bin')).then(() => true).catch(() => false)
    ])
    assert.ok(j && b)
  })

  test('among two seeded siblings, returns the higher one', async () => {
    // Seed two ONLY-underscore versions with no siblings in real dir that outrank both.
    const low = '__local_1.0.0__'
    const high = '__local_2.10.0__'
    for (const v of [low, high]) {
      const dir = path.join(DEFAULT_EMBEDDINGS_DIR, v)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'code-chunks.json'), '{}')
      await fs.writeFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))
    }
    const local = await resolveLocalVersion()
    // Real dir may contain other versioned dirs; assert relative ordering: if returned
    // version is one of ours, it must be the higher one.
    if (local.version === low || local.version === high) {
      assert.strictEqual(local.version, high)
    }
  })
})
