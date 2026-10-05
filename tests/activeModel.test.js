import { test, describe, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import fsp from 'node:fs/promises'
import os from 'node:os'

function frame(body, bin) {
  const metaBuf = Buffer.from(JSON.stringify(body))
  const binBuf = Buffer.isBuffer(bin) ? bin : Buffer.from(bin)
  const hdr = Buffer.alloc(4)
  hdr.writeUInt32BE(metaBuf.length, 0)
  return Buffer.concat([hdr, metaBuf, binBuf])
}

const seedFile = (p, d) => fsp.mkdir(path.dirname(p), { recursive: true }).then(() => fsp.writeFile(p, d))

process.env.CDS_MCP_OFFLINE = 'true'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'activeModel-'))

const { downloadEmbeddings } = await import('../lib/searchMarkdownDocs.js')
const { DEFAULT_DIR, setActiveModel, getActiveModel, toDirName, getActiveEmbeddingsDir, setEmbeddingsDir } = await import('../lib/calculateEmbeddings.js')
const cds = (await import('@sap/cds')).default

setEmbeddingsDir(tmpDir)

const DEFAULT_MODEL = getActiveModel()

const getManifestEtagPath = () => path.join(getActiveEmbeddingsDir(), 'etags', cds.version, 'manifest.etag')

// Etag path for the module-default model (captured after setEmbeddingsDir).
const defaultEtagPath = path.join(getActiveEmbeddingsDir(), 'etags', cds.version, 'manifest.etag')

after(async () => {
  mock.restoreAll()
  setActiveModel()
  setEmbeddingsDir()
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('active model wiring into download', () => {
  const testVer = '__test_model_bundle__'

  // Fresh tmp dir per test → clean slate, no real etag/bundle in play.
  beforeEach(async () => {
    mock.restoreAll()
    setActiveModel('foo/bar')
    setEmbeddingsDir(tmpDir)
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    await fsp.mkdir(tmpDir, { recursive: true })
  })

  // Mock: 200 framed bundle whose model matches the active model.
  describe('bundle 200, server model matches', () => {
    let fetchMock
    beforeEach(() => {
      fetchMock = mock.method(globalThis, 'fetch', async () => {
        return new Response(frame({ dim: 1, count: 1, chunks: [] }, 'BIN'), {
          status: 200,
          headers: { etag: 'W/"seed"', 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
        })
      })
    })

    test('bundle URL model= param reflects active model', async () => {
      await downloadEmbeddings()
      const url = new URL(String(fetchMock.mock.calls[0].arguments[0]))
      assert.strictEqual(url.searchParams.get('model'), 'foo--bar')
    })

    test('no throw when server model matches requested', async () => {
      await downloadEmbeddings() // must not throw
    })

    test('switching active model reads different etag path → no If-None-Match sent', async () => {
      // Seed etag under DEFAULT model's dir; active model is foo/bar → different etag
      // scope, so the download must not carry the default's If-None-Match.
      await seedFile(
        defaultEtagPath,
        JSON.stringify({
          etag: 'W/"seed"',
          commitId: testVer,
          model: DEFAULT_MODEL
        })
      )

      await downloadEmbeddings()
      assert.strictEqual((fetchMock.mock.calls[0].arguments[1] ?? {}).headers?.['If-None-Match'], undefined, 'active model uses its own etag scope')
    })

    test('written etag records active model when server omits x-embeddings-model header', async () => {
      await downloadEmbeddings()
      const saved = JSON.parse(await fsp.readFile(getManifestEtagPath(), 'utf-8'))
      assert.strictEqual(saved.model, 'foo/bar', 'must persist active model as fallback')
    })
  })

  // Mock: bundle reports a different model (wrongModel) + manifest endpoint.
  describe('model mismatch (bundle wrongModel + manifest)', () => {
    test('server returns different model → throws with available models listed', async () => {
      mock.method(globalThis, 'fetch', async (url) => {
        if (new URL(String(url)).pathname.endsWith('/manifest.json')) {
          return new Response(JSON.stringify({
            [toDirName('sentence-transformers/all-MiniLM-L6-v2')]: [{ model: 'sentence-transformers/all-MiniLM-L6-v2' }],
            [toDirName('Xenova/all-MiniLM-L6-v2')]: [{ model: 'Xenova/all-MiniLM-L6-v2' }]
          }), { status: 200 })
        }
        return new Response(frame({ dim: 1, count: 0, chunks: [], model: 't' }, 'B'), {
          status: 200,
          headers: { etag: 'W/"x"', 'x-embeddings-version': testVer, 'x-embeddings-model': DEFAULT_MODEL }
        })
      })

      await assert.rejects(
        downloadEmbeddings(),
        err =>
          /Requested model "foo\/bar" not found/.test(err.message) &&
          /sentence-transformers\/all-MiniLM-L6-v2/.test(err.message) &&
          /Xenova\/all-MiniLM-L6-v2/.test(err.message)
      )
    })

    test('manifest fetch failure → still throws, without Available list', async () => {
      mock.method(globalThis, 'fetch', async (url) => {
        if (new URL(String(url)).pathname.endsWith('/manifest.json')) {
          return new Response(null, { status: 500 })
        }
        return new Response(frame({ dim: 1, count: 0, chunks: [], model: 't' }, 'B'), {
          status: 200,
          headers: { etag: 'W/"x"', 'x-embeddings-version': testVer, 'x-embeddings-model': DEFAULT_MODEL }
        })
      })

      await assert.rejects(
        downloadEmbeddings(),
        err => /Requested model "foo\/bar" not found/.test(err.message) && !/Available models/.test(err.message)
      )
    })

    test('mismatch throw hits /manifest.json for available list', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async (url) => {
        const u = String(url)
        if (new URL(u).pathname.endsWith('/manifest.json')) {
          return new Response(JSON.stringify({ [toDirName('a/b')]: [{ model: 'a/b' }] }), { status: 200 })
        }
        return new Response(frame({ dim: 1, count: 0, chunks: [], model: 't' }, 'B'), {
          status: 200,
          headers: { etag: 'W/"x"', 'x-embeddings-version': testVer, 'x-embeddings-model': DEFAULT_MODEL }
        })
      })

      await assert.rejects(downloadEmbeddings())
      const manifestHits = fetchMock.mock.calls.filter(c => String(c.arguments[0]).endsWith('/manifest.json'))
      assert.strictEqual(manifestHits.length, 1, 'must call manifest endpoint once')
      assert.ok(String(manifestHits[0].arguments[0]).startsWith('https://'), 'manifest URL must be absolute')
    })
  })

  // Mock: 304 Not Modified.
  describe('bundle 304 not modified', () => {
    test('etag under active model dir → 304 path returns cached dir', async () => {
      const activeEtagPath = getManifestEtagPath() // points at foo--bar/<cds>/manifest.etag
      await seedFile(
        activeEtagPath,
        JSON.stringify({
          etag: 'W/"seed"',
          commitId: testVer,
          model: 'foo/bar'
        })
      )

      const dir = path.join(getActiveEmbeddingsDir(), testVer)
      await seedFile(path.join(dir, 'code-chunks.json'), '{}')
      await seedFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))

      const fetchMock = mock.method(globalThis, 'fetch', async () => {
        return new Response(null, { status: 304 })
      })

      const r = await downloadEmbeddings()
      assert.strictEqual((fetchMock.mock.calls[0].arguments[1] ?? {}).headers?.['If-None-Match'], 'W/"seed"')
      assert.strictEqual(r.updated, false)
      assert.strictEqual(r.commitId, testVer)
    })
  })
})
