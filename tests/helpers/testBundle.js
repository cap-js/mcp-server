import { createRequire } from 'node:module'
import path from 'path'
import calculateEmbeddings, { DEFAULT_DIR, UNKNOWN_CDS_VERSION } from '../../lib/calculateEmbeddings.js'

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

export function makeFetchStub(frame, commitId = TEST_COMMIT_ID) {
  return async (_url, _init) =>
    new Response(frame, {
      status: 200,
      headers: {
        etag: `W/"${commitId}"`,
        'x-embeddings-version': commitId,
        'content-type': 'application/octet-stream'
      }
    })
}

// Mirror etagPathFor(detectRuntime().cdsVersion) from searchMarkdownDocs.js using the
// same createRequire + process.cwd() logic, so save/restore always targets the exact
// path _downloadEmbeddings() writes — including the 'latest' fallback when no CAP
// runtime is detected in the test working directory.
export function getManifestEtagPath() {
  try {
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    const c = req('@sap/cds')
    if (c.env?.['project-nature'] === 'nodejs') {
      return path.join(DEFAULT_DIR, 'etags', c.version, 'manifest.etag')
    }
  } catch {}
  return path.join(DEFAULT_DIR, 'etags', UNKNOWN_CDS_VERSION, 'manifest.etag')
}
