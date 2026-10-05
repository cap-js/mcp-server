import { test, describe, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import fsp from 'node:fs/promises'
import { remapFs } from './helpers/remap-fs.js'
import { getManifestEtagPath } from './helpers/paths.js'

function frame(body, bin) {
  const metaBuf = Buffer.from(JSON.stringify(body))
  const binBuf = Buffer.isBuffer(bin) ? bin : Buffer.from(bin)
  const hdr = Buffer.alloc(4)
  hdr.writeUInt32BE(metaBuf.length, 0)
  return Buffer.concat([hdr, metaBuf, binBuf])
}

function mockFetch(...handlers) {
  const routes = {}
  for (const h of handlers) {
    if (routes[h.endpoint]) throw new Error(`mockFetch: duplicate handler for ${h.endpoint}`)
    routes[h.endpoint] = h
  }
  const requests = []
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = String(url)
    requests.push({ url: u, headers: init.headers || {} })
    const { pathname } = new URL(u)
    const key = pathname.endsWith('/manifest.json') ? 'manifest'
      : pathname.endsWith('/getEmbeddings') ? 'getEmbeddings' : null
    const route = key && routes[key]
    if (!route) throw new TypeError(`mockFetch: endpoint not mocked: ${u}`)
    return route.respond(u, init)
  })
  return requests
}

const bundle = {
  ok({ version = '__test_bundle__', body = { dim: 1, count: 1, chunks: [] }, bin = 'BIN' } = {}) {
    return {
      endpoint: 'getEmbeddings',
      respond: async () => new Response(frame(body, bin), {
        status: 200,
        headers: { etag: 'W/"seed"', 'x-embeddings-version': version, 'content-type': 'application/octet-stream' }
      })
    }
  },
  notModified() {
    return { endpoint: 'getEmbeddings', respond: async () => new Response(null, { status: 304 }) }
  },
  okWrongModel({ version, wrongModel }) {
    return {
      endpoint: 'getEmbeddings',
      respond: async () => new Response(frame({ dim: 1, count: 0, chunks: [], model: 't' }, 'B'), {
        status: 200,
        headers: { etag: 'W/"x"', 'x-embeddings-version': version, 'x-embeddings-model': wrongModel }
      })
    }
  }
}

const manifest = {
  ok(body) {
    return { endpoint: 'manifest', respond: async () => new Response(JSON.stringify(body), { status: 200 }) }
  },
  failed(status, statusText = '') {
    return { endpoint: 'manifest', respond: async () => new Response(null, { status, statusText }) }
  }
}

process.env.CDS_MCP_OFFLINE = 'true'

const { downloadEmbeddings } = await import('../lib/searchMarkdownDocs.js')
const { DEFAULT_DIR, setActiveModel, getActiveModel, toDirName } = await import('../lib/calculateEmbeddings.js')

const DEFAULT_MODEL = getActiveModel()

// Etag path for the module-default model (captured before we switch models).
const defaultEtagPath = getManifestEtagPath()

after(() => {
  mock.restoreAll()
  setActiveModel()
})

describe('active model wiring into download', () => {
  const testVer = '__test_model_bundle__'

  // Fresh in-memory fs per test → clean slate, no real etag/bundle in play.
  beforeEach(() => {
    mock.restoreAll()
    setActiveModel('foo/bar')
    remapFs()
  })

  // Mock: 200 framed bundle whose model matches the active model.
  describe('bundle 200, server model matches', () => {
    let requests
    beforeEach(() => {
      requests = mockFetch(bundle.ok({ version: testVer }))
    })

    test('bundle URL model= param reflects active model', async () => {
      await downloadEmbeddings()
      const url = new URL(requests[0].url)
      assert.strictEqual(url.searchParams.get('model'), 'foo--bar')
    })

    test('no throw when server model matches requested', async () => {
      await downloadEmbeddings() // must not throw
    })

    test('switching active model reads different etag path → no If-None-Match sent', async () => {
      // Seed etag under DEFAULT model's dir; active model is foo/bar → different etag
      // scope, so the download must not carry the default's If-None-Match.
      await fsp.writeFile(
        defaultEtagPath,
        JSON.stringify({
          etag: 'W/"seed"',
          commitId: testVer,
          model: DEFAULT_MODEL
        })
      )

      await downloadEmbeddings()
      assert.strictEqual(requests[0].headers['If-None-Match'], undefined, 'active model uses its own etag scope')
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
      mockFetch(
        bundle.okWrongModel({ version: testVer, wrongModel: DEFAULT_MODEL }),
        manifest.ok({
          [toDirName('sentence-transformers/all-MiniLM-L6-v2')]: [{ model: 'sentence-transformers/all-MiniLM-L6-v2' }],
          [toDirName('Xenova/all-MiniLM-L6-v2')]: [{ model: 'Xenova/all-MiniLM-L6-v2' }]
        })
      )

      await assert.rejects(
        downloadEmbeddings(),
        err =>
          /Requested model "foo\/bar" not found/.test(err.message) &&
          /sentence-transformers\/all-MiniLM-L6-v2/.test(err.message) &&
          /Xenova\/all-MiniLM-L6-v2/.test(err.message)
      )
    })

    test('manifest fetch failure → still throws, without Available list', async () => {
      mockFetch(bundle.okWrongModel({ version: testVer, wrongModel: DEFAULT_MODEL }), manifest.failed(500))

      await assert.rejects(
        downloadEmbeddings(),
        err => /Requested model "foo\/bar" not found/.test(err.message) && !/Available models/.test(err.message)
      )
    })

    test('mismatch throw hits /manifest.json for available list', async () => {
      const requests = mockFetch(
        bundle.okWrongModel({ version: testVer, wrongModel: DEFAULT_MODEL }),
        manifest.ok({ [toDirName('a/b')]: [{ model: 'a/b' }] })
      )

      await assert.rejects(downloadEmbeddings())
      const manifestHits = requests.filter(r => r.url.endsWith('/manifest.json'))
      assert.strictEqual(manifestHits.length, 1, 'must call manifest endpoint once')
      assert.ok(manifestHits[0].url.startsWith('https://'), 'manifest URL must be absolute')
    })
  })

  // Mock: 304 Not Modified.
  describe('bundle 304 not modified', () => {
    test('etag under active model dir → 304 path returns cached dir', async () => {
      const activeEtagPath = getManifestEtagPath() // points at foo--bar/<cds>/manifest.etag
      await fsp.writeFile(
        activeEtagPath,
        JSON.stringify({
          etag: 'W/"seed"',
          commitId: testVer,
          model: 'foo/bar'
        })
      )

      const dir = path.join(DEFAULT_DIR, 'foo--bar', testVer)
      await fsp.writeFile(path.join(dir, 'code-chunks.json'), '{}')
      await fsp.writeFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))

      const requests = mockFetch(bundle.notModified())

      const r = await downloadEmbeddings()
      assert.strictEqual(requests[0].headers['If-None-Match'], 'W/"seed"')
      assert.strictEqual(r.updated, false)
      assert.strictEqual(r.commitId, testVer)
    })
  })
})
