// Fetch mocks for the two server endpoints.
// Each factory describes ONE endpoint:
//   bundle.*   → GET …/getEmbeddings
//   manifest.* → GET …/manifest.json
// `mockFetch(...handlers)` installs one fetch mock that routes by URL to the
// handlers you pass. A test mocks only the endpoints it needs.
import { readFileSync } from 'node:fs'
import { mock } from 'node:test'

// Binary frame: [4-byte BE meta length][meta JSON bytes][bin bytes].
function frame(body, bin) {
  const metaBuf = Buffer.from(JSON.stringify(body))
  const binBuf = Buffer.isBuffer(bin) ? bin : Buffer.from(bin)
  const hdr = Buffer.alloc(4)
  hdr.writeUInt32BE(metaBuf.length, 0)
  return Buffer.concat([hdr, metaBuf, binBuf])
}

const TEST_CHUNKS = [
  'To create a new CAP project, run: cds init my-project. The cds init command scaffolds a minimal project.',
  'Use cds add hana to add HANA support. First run cds init to bootstrap the project structure.',
  'Enterprise messaging in CAP uses enterprise-messaging as the service binding kind in package.json under cds.requires.',
  'SAP Event Mesh (enterprise-messaging) enables async messaging between microservices in CAP applications.',
  'Define CDS entities: entity Books { key ID: Integer; title: String; author: Association to Authors; }',
  'Expose entities via services: service CatalogService { entity Books as projection on my.Books; }',
  'CQL SELECT statement syntax: SELECT from Books where title = :title order by title asc'
]

export async function buildTestBundle() {
  const { default: calculateEmbeddings } = await import('../../lib/calculateEmbeddings.js')
  const vecs = await Promise.all(TEST_CHUNKS.map(chunk => calculateEmbeddings(chunk)))
  const dim = vecs[0].length
  const flat = new Float32Array(TEST_CHUNKS.length * dim)
  for (let i = 0; i < vecs.length; i++) flat.set(vecs[i], i * dim)
  const meta = { dim, count: TEST_CHUNKS.length, chunks: TEST_CHUNKS }
  const metaBuf = Buffer.from(JSON.stringify(meta))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(metaBuf.length, 0)
  return Buffer.concat([header, metaBuf, Buffer.from(flat.buffer)])
}

let _realFrame = null

// Installs one fetch mock. Routes each request to the handler for its endpoint.
// Returns the request log: one `{ url, headers }` entry per fetch call.
export function mockFetch(...handlers) {
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
    const key = pathname.endsWith('/manifest.json')
      ? 'manifest'
      : pathname.endsWith('/getEmbeddings')
        ? 'getEmbeddings'
        : null
    const route = key && routes[key]
    if (!route) throw new TypeError(`mockFetch: endpoint not mocked: ${u}`)
    return route.respond(u, init)
  })
  return requests
}

// Handlers for the bundle endpoint — GET …/getEmbeddings.
export const bundle = {
  // 200 framed bundle.
  ok({ version = '__test_bundle__', body = { dim: 1, count: 1, chunks: [] }, bin = 'BIN' } = {}) {
    return {
      endpoint: 'getEmbeddings',
      respond: async () =>
        new Response(frame(body, bin), {
          status: 200,
          headers: { etag: 'W/"seed"', 'x-embeddings-version': version, 'content-type': 'application/octet-stream' }
        })
    }
  },

  // 200 framed bundle built from real embeddings of TEST_CHUNKS.
  // The frame is computed once and cached for the lifetime of the test process.
  okReal(version = '__test_bundle__') {
    return {
      endpoint: 'getEmbeddings',
      respond: async () => {
        if (!_realFrame) _realFrame = buildTestBundle()
        const f = await _realFrame
        return new Response(f, {
          status: 200,
          headers: { etag: `W/"${version}"`, 'x-embeddings-version': version, 'content-type': 'application/octet-stream' }
        })
      }
    }
  },

  // 304 Not Modified — the manifest is unchanged for this cds version.
  notModified() {
    return { endpoint: 'getEmbeddings', respond: async () => new Response(null, { status: 304 }) }
  },

  // Non-OK status.
  failed(status, statusText = '', headers = {}) {
    return { endpoint: 'getEmbeddings', respond: async () => new Response(null, { status, statusText, headers }) }
  },

  // 200 with a raw body — for framing edge cases.
  okRaw(body, headers = {}) {
    return { endpoint: 'getEmbeddings', respond: async () => new Response(body, { status: 200, headers }) }
  },

  // 200 framed bundle that reports a different model via x-embeddings-model.
  okWrongModel({ version, wrongModel }) {
    return {
      endpoint: 'getEmbeddings',
      respond: async () =>
        new Response(frame({ dim: 1, count: 0, chunks: [], model: 't' }, 'B'), {
          status: 200,
          headers: { etag: 'W/"x"', 'x-embeddings-version': version, 'x-embeddings-model': wrongModel }
        })
    }
  },

  // Fetch throws — simulates a network failure.
  networkError(message = 'network down') {
    return {
      endpoint: 'getEmbeddings',
      respond: async () => {
        throw new TypeError(message)
      }
    }
  },

  // 200 framed bundle after a delay; the returned object's `.tracking.maxConcurrent`
  // records the peak number of overlapping fetch calls.
  okConcurrent(version, delayMs = 30) {
    let concurrent = 0
    const tracking = { maxConcurrent: 0 }
    return {
      endpoint: 'getEmbeddings',
      tracking,
      respond: async () => {
        concurrent++
        tracking.maxConcurrent = Math.max(tracking.maxConcurrent, concurrent)
        await new Promise(r => setTimeout(r, delayMs))
        concurrent--
        return new Response(frame({ dim: 0, count: 0, chunks: [], model: 't' }, 'BIN'), {
          status: 200,
          headers: { etag: 'W/"seed"', 'x-embeddings-version': version, 'content-type': 'application/octet-stream' }
        })
      }
    }
  }
}

// Handlers for the manifest endpoint — GET …/manifest.json.
export const manifest = {
  // 200 JSON manifest.
  ok(body) {
    return { endpoint: 'manifest', respond: async () => new Response(JSON.stringify(body), { status: 200 }) }
  },

  // Non-200 status.
  failed(status, statusText = '', headers = {}) {
    return { endpoint: 'manifest', respond: async () => new Response(null, { status, statusText, headers }) }
  },

  // Fetch throws — simulates a network failure.
  networkError(message = 'network down') {
    return {
      endpoint: 'manifest',
      respond: async () => {
        throw new TypeError(message)
      }
    }
  }
}

// Subprocess fetch mock — loaded via NODE_OPTIONS=--import "file://..."
// Reads a prebuilt bundle from CDS_MCP_TEST_BUNDLE_PATH, serves it for the bundle endpoint.
if (process.env.CDS_MCP_TEST_BUNDLE_PATH) {
  const prebuilt = readFileSync(process.env.CDS_MCP_TEST_BUNDLE_PATH)
  const commitId = process.env.CDS_MCP_TEST_BUNDLE_VERSION ?? '__test_bundle__'
  mockFetch(
    bundle.okRaw(prebuilt, {
      etag: `W/"${commitId}"`,
      'x-embeddings-version': commitId,
      'content-type': 'application/octet-stream'
    })
  )
}
