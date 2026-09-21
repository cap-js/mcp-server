import { test, describe, after, before, beforeEach } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import fs from 'fs/promises'
import {
  stubBundle, stub304, stubError, stubNetworkError,
  stubManifestWithError, stubMismatchBundle, stubRawResponse, stubConcurrentBundle
} from './helpers/mock-fetch.mjs'

process.env.CDS_MCP_OFFLINE = 'true'

const { downloadEmbeddings, resolveLocalVersion } = await import('../lib/searchMarkdownDocs.js')
const { getActiveModel, DEFAULT_DIR, toDirName } = await import('../lib/calculateEmbeddings.js')
const cds = (await import('@sap/cds')).default

const originalFetch = globalThis.fetch
const MODEL_FOLDER = toDirName(getActiveModel())
const DEFAULT_EMBEDDINGS_DIR = path.join(DEFAULT_DIR, MODEL_FOLDER)
const modelEtagsRoot = path.join(DEFAULT_DIR, MODEL_FOLDER, 'etags')
const manifestEtagPath = path.join(modelEtagsRoot, cds.version, 'manifest.etag')

// Snapshot the real etag for the installed cds version before any test runs,
// restore it after all tests complete so no pre-existing files are lost.
let _savedEtag = null
before(async () => { _savedEtag = await fs.readFile(manifestEtagPath, 'utf-8').catch(() => null) })
after(async () => {
  if (_savedEtag !== null) {
    await fs.mkdir(path.dirname(manifestEtagPath), { recursive: true })
    await fs.writeFile(manifestEtagPath, _savedEtag)
  } else {
    await fs.rm(path.dirname(manifestEtagPath), { recursive: true, force: true }).catch(() => {})
  }
})

async function clearBundleState() {
  await fs.rm(path.join(modelEtagsRoot, cds.version), { recursive: true, force: true }).catch(() => {})
}

describe('downloadEmbeddings (bundle endpoint)', () => {
  const testVer = '__test_bundle__'
  const testDir = path.join(DEFAULT_EMBEDDINGS_DIR, testVer)

  beforeEach(async () => {
    globalThis.fetch = originalFetch
    await clearBundleState()
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })
  after(async () => {
    globalThis.fetch = originalFetch
    await clearBundleState()
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  test('sends cds and model query params', async () => {
    const seen = stubBundle({ version: testVer })
    await downloadEmbeddings()
    const url = new URL(seen[0].url)
    assert.strictEqual(url.pathname.endsWith('/getEmbeddings'), true)
    assert.strictEqual(url.searchParams.get('cds'), cds.version)
    assert.strictEqual(url.searchParams.get('model'), MODEL_FOLDER)
  })

  test('writes versioned json + bin and returns updated=true', async () => {
    stubBundle({ version: testVer, body: { dim: 1, count: 1, chunks: ['hi'] }, bin: Buffer.from(new Float32Array([1.5]).buffer) })
    const r = await downloadEmbeddings()
    assert.strictEqual(r.updated, true)
    assert.strictEqual(r.commitId, testVer)

    const meta = JSON.parse(await fs.readFile(path.join(testDir, 'code-chunks.json'), 'utf-8'))
    assert.deepStrictEqual(meta.chunks, ['hi'])
    assert.strictEqual(meta.embeddings, undefined, 'embeddings field must be stripped from meta json')

    const bin = await fs.readFile(path.join(testDir, 'code-chunks.bin'))
    assert.strictEqual(bin.length, 4, '1 chunk * 1 dim * 4 bytes')
  })

  test('persists etag+commitId, sends If-None-Match on next call, 304 → returns stored version dir', async () => {
    stubBundle({ version: testVer })
    await downloadEmbeddings()
    const saved = JSON.parse(await fs.readFile(manifestEtagPath, 'utf-8'))
    assert.strictEqual(saved.etag, 'W/"seed"')
    assert.strictEqual(saved.commitId, testVer)

    const captured = stub304()
    const r = await downloadEmbeddings()
    assert.strictEqual(captured.headers?.['If-None-Match'], 'W/"seed"')
    assert.strictEqual(r.updated, false)
    assert.strictEqual(r.commitId, testVer, '304 returns the commit id stored alongside the etag')
  })

  test('304 returns the stored commit id, not the newest local dir', async () => {
    // Seed two local versioned dirs — a newer one and an older one.
    const older = '__test_bundle_1.0.0__'
    const newer = '__test_bundle_9.9.9__'
    for (const v of [older, newer]) {
      const dir = path.join(DEFAULT_EMBEDDINGS_DIR, v)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'code-chunks.json'), '{}')
      await fs.writeFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))
    }
    // Etag file says: for THIS cds version, server would serve `older`.
    await fs.mkdir(path.dirname(manifestEtagPath), { recursive: true })
    await fs.writeFile(manifestEtagPath, JSON.stringify({ etag: 'W/"seed"', commitId: older }))

    stub304()
    const r = await downloadEmbeddings()
    assert.strictEqual(r.commitId, older, '304 must return stored version, not newest-local')
    assert.strictEqual(r.localDir, path.join(DEFAULT_EMBEDDINGS_DIR, older))

    // Cleanup.
    for (const v of [older, newer]) await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, v), { recursive: true, force: true }).catch(() => {})
  })

  test('throws when bundle 304 but etag file has no commitId', async () => {
    await fs.mkdir(path.dirname(manifestEtagPath), { recursive: true })
    await fs.writeFile(manifestEtagPath, JSON.stringify({ etag: 'W/"orphan"' }))
    stub304()
    await assert.rejects(downloadEmbeddings(), /no commitId/)
  })

  test('throws when bundle 304 but the stored commit id dir is missing on disk', async () => {
    await fs.mkdir(path.dirname(manifestEtagPath), { recursive: true })
    await fs.writeFile(manifestEtagPath, JSON.stringify({ etag: 'W/"orphan"', commitId: '__gone__' }))
    await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, '__gone__'), { recursive: true, force: true }).catch(() => {})
    stub304()
    await assert.rejects(downloadEmbeddings(), /missing files/)
  })

  test('throws when bundle response is non-OK', async () => {
    stubError(500, 'Server Err')
    await assert.rejects(downloadEmbeddings(), /Failed to fetch bundle: 500/)
  })

  test('non-OK error includes available models when manifest is reachable', async () => {
    stubManifestWithError(
      { 'model-a': [{ model: 'model-a' }], 'model-b': [{ model: 'model-b' }] },
      { status: 404, statusText: 'Not Found' }
    )
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /Failed to fetch bundle: 404/)
      assert.match(err.message, /Available models/)
      assert.match(err.message, /model-a/)
      return true
    })
  })

  test('non-OK error has no suffix when manifest is unreachable', async () => {
    stubError(503, 'Unavailable')
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /Failed to fetch bundle: 503/)
      assert.doesNotMatch(err.message, /Available models/)
      return true
    })
  })

  test('non-OK with x-embeddings-model header throws non-OK error, not model-mismatch', async () => {
    stubManifestWithError({}, { status: 400, statusText: 'Bad Request', headers: { 'x-embeddings-model': 'some--other-model' } })
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /Failed to fetch bundle: 400/)
      assert.doesNotMatch(err.message, /not found/)
      return true
    })
  })

  test('model mismatch throws "not found" with available models list', async () => {
    const wrongModel = 'sentence-transformers--different-model'
    const correctModelName = 'sentence-transformers/different-model'
    const correctModelFolderName = toDirName(correctModelName)
    stubMismatchBundle({
      manifest: { [correctModelFolderName]: [{ model: correctModelName }] },
      version: testVer,
      wrongModel
    })
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /not found/)
      assert.match(err.message, /Available models/)
      // Real model name (what --model accepts), not the on-disk folder key.
      assert.match(err.message, /sentence-transformers\/different-model/)
      return true
    })
  })

  test('model mismatch without available models omits suffix', async () => {
    const wrongModel = 'sentence-transformers--different-model'
    stubMismatchBundle({ manifest: null, manifestStatus: 503, version: testVer, wrongModel })
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /not found/)
      assert.doesNotMatch(err.message, /Available models/)
      return true
    })
  })

  test('throws when bundle response lacks X-Embeddings-Version header', async () => {
    stubRawResponse(
      JSON.stringify({ dim: 0, count: 0, chunks: [], embeddings: Buffer.from('X').toString('base64') }),
      { etag: 'W/"x"' }
    )
    await assert.rejects(downloadEmbeddings(), /missing X-Embeddings-Version/)
  })

  test('throws when bundle frame is truncated (metaLen exceeds body)', async () => {
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(9999, 0)
    stubRawResponse(
      Buffer.concat([hdr, Buffer.from('short')]),
      { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
    )
    await assert.rejects(downloadEmbeddings(), /framing/)
  })

  test('propagates fetch network error', async () => {
    stubNetworkError('network down')
    await assert.rejects(downloadEmbeddings(), /network down/)
  })

  test('when detection misses, etag lands under "latest" pseudo-version, never "unknown"', async () => {
    stubBundle({ version: testVer })

    const os = await import('node:os')
    const originalCwd = process.cwd()
    const newestEtag = path.join(modelEtagsRoot, 'latest', 'manifest.etag')
    const unknownEtag = path.join(modelEtagsRoot, 'unknown', 'manifest.etag')
    await fs.rm(path.join(modelEtagsRoot, 'latest'), { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(modelEtagsRoot, 'unknown'), { recursive: true, force: true }).catch(() => {})

    try {
      process.chdir(os.tmpdir())
      await downloadEmbeddings()

      const unknownExists = await fs.access(unknownEtag).then(() => true).catch(() => false)
      assert.strictEqual(unknownExists, false, 'no etag file may be created under <DEFAULT_DIR>/etags/unknown/')

      const newestExists = await fs.access(newestEtag).then(() => true).catch(() => false)
      assert.ok(newestExists, `etag must be written under "etags/latest" pseudo-version dir: ${newestEtag}`)

      const saved = JSON.parse(await fs.readFile(newestEtag, 'utf-8'))
      assert.strictEqual(saved.etag, 'W/"seed"', 'etag payload must match the bundle response header')
      assert.strictEqual(saved.commitId, testVer, 'stored commitId must be the x-embeddings-version returned by the server')
    } finally {
      process.chdir(originalCwd)
      await fs.rm(path.join(modelEtagsRoot, 'latest'), { recursive: true, force: true }).catch(() => {})
      await fs.rm(path.join(modelEtagsRoot, 'unknown'), { recursive: true, force: true }).catch(() => {})
    }
  })

  test('concurrent downloadEmbeddings calls must be single-flighted', async () => {
    const tracking = stubConcurrentBundle(testVer)
    const results = await Promise.allSettled([downloadEmbeddings(), downloadEmbeddings()])
    const anyRejected = results.some(r => r.status === 'rejected')
    assert.ok(
      !anyRejected && tracking.maxConcurrent === 1,
      `downloadEmbeddings must serialize concurrent callers. maxConcurrent=${tracking.maxConcurrent}, rejected=${anyRejected}`
    )
  })

  test('metaLen leaving empty bin must reject as framing error, not corruption', async () => {
    const meta = Buffer.from(JSON.stringify({ dim: 1, count: 1, chunks: ['x'], model: 't' }))
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(meta.length, 0)
    stubRawResponse(
      Buffer.concat([hdr, meta]),
      { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
    )
    await assert.rejects(
      downloadEmbeddings(),
      /empty bin|framing|bin bytes/i,
      'must reject empty-bin frame with a framing error, not silently write it'
    )
  })

  test('body shorter than 4 bytes must reject as too short', async () => {
    stubRawResponse(
      Buffer.from([0x00, 0x01, 0x02]),
      { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
    )
    await assert.rejects(downloadEmbeddings(), /too short/)
  })

  test('exactly-4-byte body (header only, metaLen=0) must reject as empty bin', async () => {
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(0, 0)
    stubRawResponse(hdr, { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' })
    await assert.rejects(downloadEmbeddings(), /empty bin|framing|bin bytes/i)
  })

  test('frame with 1 bin byte must succeed', async () => {
    const meta = Buffer.from(JSON.stringify({ dim: 1, count: 1, chunks: ['x'], model: 't' }))
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(meta.length, 0)
    stubRawResponse(
      Buffer.concat([hdr, meta, Buffer.from([0x01])]),
      { etag: 'W/"ok"', 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
    )
    const r = await downloadEmbeddings()
    assert.strictEqual(r.updated, true)
    const written = await fs.readFile(path.join(DEFAULT_EMBEDDINGS_DIR, testVer, 'code-chunks.bin'))
    assert.strictEqual(written.length, 1)
    assert.strictEqual(written[0], 0x01)
  })
})

describe('resolveLocalVersion', () => {
  const testCommits = ['__local_commit_a__', '__local_commit_b__', '__local_commit_c__']
  const testCdsDirs = ['1.0.0', '2.5.0', '2.10.0']

  async function seedEtag(cdsVer, commitId) {
    const ep = path.join(modelEtagsRoot, cdsVer, 'manifest.etag')
    await fs.mkdir(path.dirname(ep), { recursive: true })
    await fs.writeFile(ep, JSON.stringify({ etag: 'W/"x"', commitId }))
    return ep
  }
  async function seedEmbedDir(commitId, complete = true) {
    const dir = path.join(DEFAULT_EMBEDDINGS_DIR, commitId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'code-chunks.json'), '{}')
    if (complete) await fs.writeFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))
    return dir
  }

  beforeEach(async () => {
    for (const v of testCdsDirs) await fs.rm(path.join(modelEtagsRoot, v), { recursive: true, force: true }).catch(() => {})
    for (const c of testCommits) await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, c), { recursive: true, force: true }).catch(() => {})
  })
  after(async () => {
    for (const v of testCdsDirs) await fs.rm(path.join(modelEtagsRoot, v), { recursive: true, force: true }).catch(() => {})
    for (const c of testCommits) await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, c), { recursive: true, force: true }).catch(() => {})
  })

  test('returns commitId from etag and skips incomplete embed dirs', async () => {
    // complete dir for commit_a, incomplete for commit_b
    await seedEmbedDir(testCommits[0])
    await seedEmbedDir(testCommits[1], false)  // missing .bin
    await seedEtag('1.0.0', testCommits[0])
    await seedEtag('2.5.0', testCommits[1])

    const local = await resolveLocalVersion()
    assert.ok(local)
    // commit_b's dir is incomplete → must resolve to commit_a (only complete one)
    assert.strictEqual(local.commitId, testCommits[0])
    assert.strictEqual(local.localDir, path.join(DEFAULT_EMBEDDINGS_DIR, testCommits[0]))
    const [j, b] = await Promise.all([
      fs.access(path.join(local.localDir, 'code-chunks.json')).then(() => true).catch(() => false),
      fs.access(path.join(local.localDir, 'code-chunks.bin')).then(() => true).catch(() => false)
    ])
    assert.ok(j && b)
  })

  test('among two cds versions with complete dirs, returns commitId from highest cds version', async () => {
    await seedEmbedDir(testCommits[0])
    await seedEmbedDir(testCommits[1])
    await seedEtag('1.0.0', testCommits[0])
    await seedEtag('2.10.0', testCommits[1])

    const local = await resolveLocalVersion()
    assert.strictEqual(local.commitId, testCommits[1], 'must pick commitId from highest semver cds dir')
  })

  test('among non-semver cds dirs, must tiebreak by mtime, not readdir order', async () => {
    const dirs = ['bundle_alpha', 'bundle_beta']
    await seedEmbedDir(testCommits[0])
    await seedEmbedDir(testCommits[1])
    // seed etag files under non-semver dir names
    for (let i = 0; i < dirs.length; i++) {
      const ep = path.join(modelEtagsRoot, dirs[i], 'manifest.etag')
      await fs.mkdir(path.dirname(ep), { recursive: true })
      await fs.writeFile(ep, JSON.stringify({ etag: 'W/"x"', commitId: testCommits[i] }))
    }
    const now = Date.now() / 1000
    // control mtime on the embed dirs themselves — last-resort uses those, not etag dirs
    await fs.utimes(path.join(DEFAULT_EMBEDDINGS_DIR, testCommits[0]), now - 100, now - 100)
    await fs.utimes(path.join(DEFAULT_EMBEDDINGS_DIR, testCommits[1]), now, now)
    // both etag dirs have non-semver names → semver scan skips them → fall through to mtime last-resort
    try {
      const local = await resolveLocalVersion()
      assert.ok(local, 'last-resort must find a complete embed dir')
      assert.strictEqual(local.commitId, testCommits[1], 'must pick newer embed dir by mtime')
    } finally {
      for (const v of dirs) await fs.rm(path.join(modelEtagsRoot, v), { recursive: true, force: true }).catch(() => {})
    }
  })

  test('picks etag under "latest" pseudo dir when no semver dirs match', async () => {
    await seedEmbedDir(testCommits[0])
    // Seed etag under UNKNOWN_CDS_VERSION pseudo dir only.
    const ep = path.join(modelEtagsRoot, 'latest', 'manifest.etag')
    await fs.mkdir(path.dirname(ep), { recursive: true })
    await fs.writeFile(ep, JSON.stringify({ etag: 'W/"x"', commitId: testCommits[0] }))

    try {
      const local = await resolveLocalVersion()
      assert.ok(local)
      assert.strictEqual(local.commitId, testCommits[0], 'must fall back to pseudo dir etag')
    } finally {
      await fs.rm(path.join(modelEtagsRoot, 'latest'), { recursive: true, force: true }).catch(() => {})
    }
  })

  test('real semver dir beats "latest" pseudo dir', async () => {
    await seedEmbedDir(testCommits[0])
    await seedEmbedDir(testCommits[1])
    // pseudo → commit_a; real semver → commit_b. Real wins.
    const pseudoEp = path.join(modelEtagsRoot, 'latest', 'manifest.etag')
    await fs.mkdir(path.dirname(pseudoEp), { recursive: true })
    await fs.writeFile(pseudoEp, JSON.stringify({ etag: 'W/"x"', commitId: testCommits[0] }))
    await seedEtag('1.0.0', testCommits[1])

    try {
      const local = await resolveLocalVersion()
      assert.strictEqual(local.commitId, testCommits[1], 'real semver must beat pseudo dir')
    } finally {
      await fs.rm(path.join(modelEtagsRoot, 'latest'), { recursive: true, force: true }).catch(() => {})
    }
  })

  test('last-resort scan skips the etags subdir inside a model folder', async () => {
    // Seed only the etags dir (no commit dirs), plus one real commit dir.
    await seedEmbedDir(testCommits[0])
    const pseudoEp = path.join(modelEtagsRoot, 'latest', 'manifest.etag')
    await fs.mkdir(path.dirname(pseudoEp), { recursive: true })
    // Etag file has NO commitId — pseudo route can't return anything.
    await fs.writeFile(pseudoEp, JSON.stringify({ etag: 'W/"x"' }))

    try {
      const local = await resolveLocalVersion()
      // Must find real commit dir via last-resort; must NOT return 'etags' as commitId.
      assert.ok(local)
      assert.strictEqual(local.commitId, testCommits[0], 'last-resort must skip inner etags/ dir')
      assert.notStrictEqual(local.commitId, 'etags')
    } finally {
      await fs.rm(path.join(modelEtagsRoot, 'latest'), { recursive: true, force: true }).catch(() => {})
    }
  })
})
