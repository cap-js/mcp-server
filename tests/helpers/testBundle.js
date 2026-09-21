import { createRequire } from 'node:module'
import path from 'path'
import calculateEmbeddings, { DEFAULT_DIR, UNKNOWN_CDS_VERSION, getActiveModelFolder } from '../../lib/calculateEmbeddings.js'

export const TEST_COMMIT_ID = '__test_bundle__'

// Small CAP-relevant chunks covering assertions in integration tests:
// - 'cds init' for query 'how to create a new cap project'
// - 'enterprise-messaging' for query 'event mesh config'
const TEST_CHUNKS = [
  'To create a new CAP project, run: cds init my-project. The cds init command scaffolds a minimal project.',
  'Use cds add hana to add HANA support. First run cds init to bootstrap the project structure.',
  'Enterprise messaging in CAP uses enterprise-messaging as the service binding kind in package.json under cds.requires.',
  'SAP Event Mesh (enterprise-messaging) enables async messaging between microservices in CAP applications.',
  'Define CDS entities: entity Books { key ID: Integer; title: String; author: Association to Authors; }',
  'Expose entities via services: service CatalogService { entity Books as projection on my.Books; }',
  'CQL SELECT statement syntax: SELECT from Books where title = :title order by title asc',
]

export async function buildTestBundle() {
  const vecs = await Promise.all(TEST_CHUNKS.map(c => calculateEmbeddings(c)))
  const dim = vecs[0].length
  const flat = new Float32Array(TEST_CHUNKS.length * dim)
  for (let i = 0; i < vecs.length; i++) flat.set(vecs[i], i * dim)
  const meta = { dim, count: TEST_CHUNKS.length, chunks: TEST_CHUNKS }
  const metaBuf = Buffer.from(JSON.stringify(meta))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(metaBuf.length, 0)
  return Buffer.concat([header, metaBuf, Buffer.from(flat.buffer)])
}

// Fetch stub for tests. Serves a bundle response by default; routes
// `/manifest.json` requests separately when `manifest` is provided; returns 304
// for the bundle URL when `notModified` is true.
//
// - `frame`: pre-built bundle frame (from buildTestBundle); wins over body/bin.
// - `body`/`bin`: synthetic bundle inputs — wrapped in `[4-byte BE metaLen][meta][bin]`.
// - `manifest`: array of model names OR `{folder: [...]}` object; served at `/manifest.json`.
// - `manifestStatus`: override manifest response status (e.g. 500).
// - `notModified`: return 304 (no body) for bundle URL; still serves manifest.
//
// Returns `{ fetch, seen }`. `seen` records every call as `{url, headers}`.
// Backwards-compat: called with a raw Buffer (`makeFetchStub(frame)`), returns
// the fetch fn directly for legacy call sites.
export function makeFetchStub(optsOrFrame = {}, legacyCommitId) {
  if (Buffer.isBuffer(optsOrFrame)) {
    const { fetch } = _buildStub({ frame: optsOrFrame, version: legacyCommitId ?? TEST_COMMIT_ID })
    return fetch
  }
  return _buildStub(optsOrFrame)
}

function _buildStub({
  frame = null,
  version = TEST_COMMIT_ID,
  model = null,
  etag = 'W/"seed"',
  body = { dim: 1, count: 1, chunks: [] },
  bin = 'BIN',
  manifest = null,
  manifestStatus = 200,
  notModified = false
} = {}) {
  const realFetch = globalThis.fetch  // captured before the stub replaces globalThis.fetch
  const seen = []
  let bundleFrame = frame
  if (!bundleFrame) {
    const metaBuf = Buffer.from(JSON.stringify(body))
    const binBuf = Buffer.isBuffer(bin) ? bin : Buffer.from(bin)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(metaBuf.length, 0)
    bundleFrame = Buffer.concat([header, metaBuf, binBuf])
  }
  const bundleHeaders = { etag, 'x-embeddings-version': version, 'content-type': 'application/octet-stream' }
  if (model) bundleHeaders['x-embeddings-model'] = model

  const manifestObj = Array.isArray(manifest)
    ? Object.fromEntries(manifest.map(name => [name.replace(/\//g, '--'), [{ model: name }]]))
    : manifest

  const fetchStub = async (url, init = {}) => {
    const urlStr = String(url)
    if (!urlStr.includes('cap.cloud.sap')) return realFetch(url, init)
    seen.push({ url: urlStr, headers: init.headers || {} })
    if (urlStr.endsWith('/manifest.json')) {
      if (manifestStatus !== 200) return new Response('', { status: manifestStatus })
      return new Response(JSON.stringify(manifestObj ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (notModified) return new Response(null, { status: 304 })
    return new Response(bundleFrame, { status: 200, headers: bundleHeaders })
  }
  return { fetch: fetchStub, seen }
}

export function installFetch(opts) {
  const { fetch: stub, seen } = _buildStub(opts)
  globalThis.fetch = stub
  return seen
}

// Mirror etagPathFor(detectRuntime().cdsVersion, activeModelFolder) from
// searchMarkdownDocs.js — etag files live inside the model folder:
// <DEFAULT_DIR>/<modelFolder>/etags/<cdsVersion>/manifest.etag. Uses the
// 'latest' pseudo-version when no CAP runtime is detected.
export function getManifestEtagPath() {
  const modelFolder = getActiveModelFolder()
  try {
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    const c = req('@sap/cds')
    if (c.env?.['project-nature'] === 'nodejs') {
      return path.join(DEFAULT_DIR, modelFolder, 'etags', c.version, 'manifest.etag')
    }
  } catch { /* not a cds node project */ }
  return path.join(DEFAULT_DIR, modelFolder, 'etags', UNKNOWN_CDS_VERSION, 'manifest.etag')
}
