// Subprocess fetch mock — loaded via NODE_OPTIONS=--import "file://..."
// Reads bundle from CDS_MCP_TEST_BUNDLE_PATH, serves it for any fetch call.
import { readFileSync } from 'node:fs'

if (process.env.CDS_MCP_TEST_BUNDLE_PATH) {
  const frame = readFileSync(process.env.CDS_MCP_TEST_BUNDLE_PATH)
  const commitId = process.env.CDS_MCP_TEST_BUNDLE_VERSION ?? '__test_bundle__'
  globalThis.fetch = async (_url, _init) =>
    new Response(frame, {
      status: 200,
      headers: {
        etag: `W/"${commitId}"`,
        'x-embeddings-version': commitId,
        'content-type': 'application/octet-stream'
      }
    })
}

export function stubBundle({ version = '__test_bundle__', body = { dim: 1, count: 1, chunks: [] }, bin = 'BIN' } = {}) {
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {} })
    const metaBuf = Buffer.from(JSON.stringify(body))
    const binBuf = Buffer.from(bin)
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(metaBuf.length, 0)
    const frame = Buffer.concat([hdr, metaBuf, binBuf])
    return new Response(frame, {
      status: 200,
      headers: { etag: 'W/"seed"', 'x-embeddings-version': version, 'content-type': 'application/octet-stream' }
    })
  }
  return seen
}

// Returns a `captured` object whose `.headers` field is set to the request headers of each call.
export function stub304() {
  const captured = { headers: null }
  globalThis.fetch = async (_url, init = {}) => {
    captured.headers = init.headers || {}
    return new Response(null, { status: 304 })
  }
  return captured
}

export function stubError(status, statusText = '', headers = {}) {
  globalThis.fetch = async () => new Response(null, { status, statusText, headers })
}

export function stubNetworkError(message = 'network down') {
  globalThis.fetch = async () => { throw new TypeError(message) }
}

// Routes manifest.json requests to a JSON manifest response, all other requests to an error.
export function stubManifestWithError(manifest, { status, statusText = '', headers = {} } = {}) {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('manifest.json'))
      return new Response(JSON.stringify(manifest), { status: 200 })
    return new Response(null, { status, statusText, headers })
  }
}

// Routes manifest.json to manifest (or error when null), all other requests to a mismatch bundle.
export function stubMismatchBundle({ manifest, manifestStatus = 200, version, wrongModel }) {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('manifest.json'))
      return manifest !== null
        ? new Response(JSON.stringify(manifest), { status: manifestStatus })
        : new Response(null, { status: manifestStatus })
    const meta = Buffer.from(JSON.stringify({ dim: 1, count: 0, chunks: [], model: 't' }))
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(meta.length, 0)
    return new Response(Buffer.concat([hdr, meta, Buffer.from('B')]), {
      status: 200,
      headers: { etag: 'W/"x"', 'x-embeddings-version': version, 'x-embeddings-model': wrongModel }
    })
  }
}

// Returns a raw response body — used for testing framing edge cases.
export function stubRawResponse(body, headers = {}) {
  globalThis.fetch = async () => new Response(body, { status: 200, headers })
}

// Returns a `tracking` object whose `.maxConcurrent` field records peak concurrent fetch calls.
export function stubConcurrentBundle(version, delayMs = 30) {
  let concurrent = 0
  const tracking = { maxConcurrent: 0 }
  globalThis.fetch = async () => {
    concurrent++
    tracking.maxConcurrent = Math.max(tracking.maxConcurrent, concurrent)
    await new Promise(r => setTimeout(r, delayMs))
    concurrent--
    const meta = Buffer.from(JSON.stringify({ dim: 0, count: 0, chunks: [], model: 't' }))
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(meta.length, 0)
    return new Response(Buffer.concat([hdr, meta, Buffer.from('BIN')]), {
      status: 200,
      headers: { etag: 'W/"seed"', 'x-embeddings-version': version, 'content-type': 'application/octet-stream' }
    })
  }
  return tracking
}
