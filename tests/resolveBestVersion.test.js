import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Prevent module-load download from hitting the network.
process.env.CDS_MCP_OFFLINE = 'true'

const { resolveBestVersion } = await import('../lib/searchMarkdownDocs.js')
const { MODEL_FOLDER, DEFAULT_EMBEDDINGS_DIR } = await import('../lib/calculateEmbeddings.js')
const cds = (await import('@sap/cds')).default

const originalFetch = globalThis.fetch

function stubFetch(manifestBody, opts = {}) {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/versions.json')) {
      if (opts.status && !opts.ok) return new Response(null, { status: opts.status })
      if (manifestBody === null) return new Response('not json', { status: 200 })
      return new Response(JSON.stringify(manifestBody), { status: 200 })
    }
    return new Response(null, { status: 404 })
  }
}

describe('resolveBestVersion', () => {
  beforeEach(() => { globalThis.fetch = originalFetch })
  after(() => { globalThis.fetch = originalFetch })

  test('returns null when manifest fetch fails', async () => {
    stubFetch(null, { status: 500, ok: false })
    const r = await resolveBestVersion()
    assert.strictEqual(r, null)
  })

  test('returns null when MODEL_FOLDER key missing', async () => {
    stubFetch({ 'other-model': [{ version: '1.0.0', cdsDevDependency: '>=9' }] })
    const r = await resolveBestVersion()
    assert.strictEqual(r, null)
  })

  test('returns null when entries is empty', async () => {
    stubFetch({ [MODEL_FOLDER]: [] })
    const r = await resolveBestVersion()
    assert.strictEqual(r, null)
  })

  test('returns null when no entry satisfies cds.version', async () => {
    stubFetch({ [MODEL_FOLDER]: [{ version: '1.0.0', cdsDevDependency: '>=999' }] })
    const r = await resolveBestVersion()
    assert.strictEqual(r, null)
  })

  test('picks newest suited version, filtering unsatisfied ranges', async () => {
    stubFetch({
      [MODEL_FOLDER]: [
        { version: '2025.1.1', cdsDevDependency: '>=8' },
        { version: '2026.5.7', cdsDevDependency: '>=9' },
        { version: '9999.9.9', cdsDevDependency: '>=999' }
      ]
    })
    const r = await resolveBestVersion()
    assert.ok(r)
    assert.strictEqual(r.version, '2026.5.7')
    assert.ok(r.versionUrl.endsWith(`/${MODEL_FOLDER}/2026.5.7`))
    assert.strictEqual(r.localDir, path.join(DEFAULT_EMBEDDINGS_DIR, '2026.5.7'))
  })

  test('entries without cdsDevDependency are treated as always-suited', async () => {
    stubFetch({
      [MODEL_FOLDER]: [
        { version: '1.0.0' },
        { version: '2.0.0' }
      ]
    })
    const r = await resolveBestVersion()
    assert.strictEqual(r.version, '2.0.0')
  })

  test('skips entries missing version field', async () => {
    stubFetch({
      [MODEL_FOLDER]: [
        { cdsDevDependency: '>=9' },
        { version: '1.2.3', cdsDevDependency: '>=9' }
      ]
    })
    const r = await resolveBestVersion()
    assert.strictEqual(r.version, '1.2.3')
  })

  test('cached=true when local dir already has both files', async () => {
    const tmpVer = '__test_cached__'
    const tmpDir = path.join(DEFAULT_EMBEDDINGS_DIR, tmpVer)
    await fs.mkdir(tmpDir, { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'code-chunks.json'), '{}')
    await fs.writeFile(path.join(tmpDir, 'code-chunks.bin'), Buffer.alloc(0))
    try {
      stubFetch({ [MODEL_FOLDER]: [{ version: tmpVer, cdsDevDependency: `>=${semverMajor(cds.version)}` }] })
      const r = await resolveBestVersion()
      assert.strictEqual(r.version, tmpVer)
      assert.strictEqual(r.cached, true)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('cached=false when local dir absent', async () => {
    stubFetch({ [MODEL_FOLDER]: [{ version: '__test_missing__', cdsDevDependency: `>=${semverMajor(cds.version)}` }] })
    const r = await resolveBestVersion()
    assert.strictEqual(r.cached, false)
  })
})

function semverMajor(v) {
  return parseInt(String(v).split('.')[0], 10)
}
