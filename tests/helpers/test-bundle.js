// Test bundle fixtures and setup helpers.
//
// A "bundle" is the server's binary frame: [4-byte BE meta length][meta JSON][bin].
// `buildTestBundle` builds a real embeddings frame from TEST_CHUNKS.
//
//   - seedCliTestBundle()  — REAL DISK. The CLI tests spawn child `node`
//     processes, which the in-process mock cannot reach, so the frame must sit
//     on the real disk. Use it for subprocess tests.
//
// For in-process tests, call remapFs() + mockFetch(bundle.okReal()) directly.

import path from 'node:path'
import os from 'node:os'
import { writeFile, mkdir, rm, unlink, readFile } from 'node:fs/promises'
import { TEST_COMMIT_ID, getManifestEtagPath, versionDir } from './paths.js'

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

// Split the server frame — [4-byte BE meta length][meta JSON][bin] — back into
// its two parts. Inverse of the layout buildTestBundle writes.
export function unframeBundle(frame) {
  const metaLen = frame.readUInt32BE(0)
  return { meta: frame.subarray(4, 4 + metaLen), bin: frame.subarray(4 + metaLen) }
}

// Seed the REAL disk for the subprocess-based CLI tests. Those tests spawn child
// `node` processes, so the in-process fs mock never reaches them — the child reads
// real files. This builds the frame once, drops it at a temp path for the subprocess
// fetch mock (CDS_MCP_TEST_BUNDLE_PATH), and unpacks it into the versioned embeddings
// dir so the --offline scan (resolveLocalVersion) finds it. The writes use named
// fs imports, so they stay on the real disk even if a test also calls remapFs().
// Returns a handle whose cleanup() leaves the embeddings tree as it was found.
export async function seedCliTestBundle() {
  const frame = await buildTestBundle()
  const { meta, bin } = unframeBundle(frame)

  const bundlePath = path.join(os.tmpdir(), `cds-mcp-test-bundle-${process.pid}.bin`)
  const dir = versionDir(TEST_COMMIT_ID)
  const etagPath = getManifestEtagPath()
  const savedEtag = await readFile(etagPath, 'utf-8').catch(() => null)

  await writeFile(bundlePath, frame)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'code-chunks.json'), meta)
  await writeFile(path.join(dir, 'code-chunks.bin'), bin)

  async function cleanup() {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await unlink(bundlePath).catch(() => {})
    if (savedEtag !== null) {
      await mkdir(path.dirname(etagPath), { recursive: true })
      await writeFile(etagPath, savedEtag)
    } else {
      await rm(path.dirname(etagPath), { recursive: true, force: true }).catch(() => {})
    }
  }

  return { bundlePath, commitId: TEST_COMMIT_ID, versionDir: dir, cleanup }
}
