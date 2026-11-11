// Test bundle fixtures and setup helpers.
//
// A "bundle" is the server's binary frame: [4-byte BE meta length][meta JSON][bin].
// `buildTestBundle` builds a real embeddings frame from TEST_CHUNKS.

import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Serialized as a subprocess preload; keep its imports and state self-contained.
async function mockBundleFetch() {
  const { readFileSync } = await import('node:fs')
  const { mock } = await import('node:test')
  const prebuilt = readFileSync(process.env.CDS_MCP_TEST_BUNDLE_PATH)
  const commitId = process.env.CDS_MCP_TEST_BUNDLE_VERSION ?? '__test_bundle__'
  mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(prebuilt, {
        status: 200,
        headers: {
          etag: `W/"${commitId}"`,
          'x-embeddings-version': commitId,
          'content-type': 'application/octet-stream'
        }
      })
  )
}

export async function seedCliTestBundle() {
  const { getActiveEmbeddingsDir } = await import('../../lib/calculateEmbeddings.js')
  const { default: cds } = await import('@sap/cds')
  const commitId = '__test_bundle__'
  const frame = await buildTestBundle({
    metadata: TEST_CHUNKS.map((_, i) => ({
      headingPath: `Test Section ${i + 1}`,
      source: 'https://cap.cloud.sap/docs/test'
    }))
  })
  const metaLen = frame.readUInt32BE(0)
  const meta = frame.subarray(4, 4 + metaLen)
  const bin = frame.subarray(4 + metaLen)
  const bundlePath = join(tmpdir(), `cds-mcp-test-bundle-${process.pid}.bin`)
  const mockScriptUrl = `data:text/javascript,${encodeURIComponent(`await (${mockBundleFetch.toString()})()`)}`
  const dir = join(getActiveEmbeddingsDir(), commitId)
  const etagPath = join(getActiveEmbeddingsDir(), 'etags', cds.version, 'manifest.etag')
  const savedEtag = await readFile(etagPath, 'utf8').catch(() => null)

  await writeFile(bundlePath, frame)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'code-chunks.json'), meta)
  await writeFile(join(dir, 'code-chunks.bin'), bin)

  async function cleanup() {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await unlink(bundlePath).catch(() => {})
    if (savedEtag !== null) {
      await mkdir(dirname(etagPath), { recursive: true })
      await writeFile(etagPath, savedEtag)
    } else {
      await rm(dirname(etagPath), { recursive: true, force: true }).catch(() => {})
    }
  }

  return { bundlePath, mockScriptUrl, commitId, versionDir: dir, cleanup }
}

export function runCliCommand(args, options = {}) {
  const cliPath = fileURLToPath(new URL('../../index.js', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { ...options, stdio: 'pipe' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.on('error', reject)
  })
}

export const TEST_CHUNKS = [
  'To create a new CAP project, run: cds init my-project. The cds init command scaffolds a minimal project.',
  'Use cds add hana to add HANA support. First run cds init to bootstrap the project structure.',
  'Enterprise messaging in CAP uses enterprise-messaging as the service binding kind in package.json under cds.requires.',
  'SAP Event Mesh (enterprise-messaging) enables async messaging between microservices in CAP applications.',
  'Define CDS entities: entity Books { key ID: Integer; title: String; author: Association to Authors; }',
  'Expose entities via services: service CatalogService { entity Books as projection on my.Books; }',
  'CQL SELECT statement syntax: SELECT from Books where title = :title order by title asc',
  'Register custom event handlers to add business logic to a CAP service.',
  'Register custom event handlers to add business logic to a CAP service.',
  'Register custom event handlers to add business logic to a CAP service.',
  'Provide localized texts for your model using i18n properties files.',
  'Provide localized texts for your model using i18n properties files.'
]

// Parallel metadata for TEST_CHUNKS: distinct labels for the runtime-specific
// duplicate trio so the surviving copy is identifiable; no label on the
// no-runtime duplicate pair to cover the label-free dedup path.
const _DEFAULT_METADATA = [
  { headingPath: 'Alpha > Init', source: 'https://example.test/docs/alpha#init' },
  { headingPath: 'Alpha > Init', source: 'https://example.test/docs/alpha#hana', label: 'node' },
  { headingPath: 'Beta > Messaging', source: 'https://example.test/docs/beta#em', label: 'node' },
  { headingPath: 'Beta > Messaging', source: 'https://example.test/docs/beta#mesh' },
  { headingPath: 'Gamma > Data', source: 'https://example.test/docs/gamma#entities' },
  { headingPath: 'Gamma > Data', source: 'https://example.test/docs/gamma#services' },
  { headingPath: 'Gamma > Query', source: 'https://example.test/docs/gamma#cql' },
  { headingPath: 'Delta > Dedup', source: 'https://example.test/docs/delta#dedup', label: 'node' },
  { headingPath: 'Delta > Dedup', source: 'https://example.test/docs/delta#dedup', label: 'java' },
  { headingPath: 'Delta > Dedup', source: 'https://example.test/docs/delta#dedup' },
  { headingPath: 'Epsilon > Generic', source: 'https://example.test/docs/epsilon#a' },
  { headingPath: 'Epsilon > Generic', source: 'https://example.test/docs/epsilon#b' }
]

export async function buildTestBundle({
  chunks = TEST_CHUNKS,
  metadata = chunks === TEST_CHUNKS ? _DEFAULT_METADATA : undefined
} = {}) {
  const { default: calculateEmbeddings } = await import('../../lib/calculateEmbeddings.js')
  const vecs = await Promise.all(chunks.map((chunk) => calculateEmbeddings(chunk)))
  const dim = vecs[0].length
  const flat = new Float32Array(chunks.length * dim)
  for (let i = 0; i < vecs.length; i++) flat.set(vecs[i], i * dim)
  const meta = { dim, count: chunks.length, chunks }
  if (metadata) meta.metadata = metadata
  const metaBuf = Buffer.from(JSON.stringify(meta))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(metaBuf.length, 0)
  return Buffer.concat([header, metaBuf, Buffer.from(flat.buffer)])
}
