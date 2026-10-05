// Test bundle fixtures and setup helpers.
//
// A "bundle" is the server's binary frame: [4-byte BE meta length][meta JSON][bin].
// `buildTestBundle` (exported from mock-fetch.mjs) makes one from real embeddings.
//
//   - seedCliTestBundle()  — REAL DISK. The CLI tests spawn child `node`
//     processes, which the in-process mock cannot reach, so the frame must sit
//     on the real disk. Use it for subprocess tests.
//
// For in-process tests, call installMemFs() + mockFetch(bundle.okReal()) directly.

import path from 'node:path'
import os from 'node:os'
import { writeFile, mkdir, rm, unlink, readFile } from 'node:fs/promises'
import { buildTestBundle } from './mock-fetch.mjs'
import { TEST_COMMIT_ID, getManifestEtagPath, versionDir } from './paths.js'

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
// fs imports, so they stay on the real disk even if a test also calls installMemFs().
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
