import { test, describe, after, before, beforeEach } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import fs from 'fs/promises'

process.env.CDS_MCP_OFFLINE = 'true'

const { downloadEmbeddings, resolveLocalVersion } = await import('../lib/searchMarkdownDocs.js')
const { DEFAULT_DIR, DEFAULT_EMBEDDINGS_DIR, MODEL_FOLDER } = await import('../lib/calculateEmbeddings.js')
const cds = (await import('@sap/cds')).default

const originalFetch = globalThis.fetch
const manifestEtagPath = path.join(DEFAULT_DIR, 'etags', cds.version, 'manifest.etag')

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
  await fs.rm(path.join(DEFAULT_DIR, 'etags', cds.version), { recursive: true, force: true }).catch(() => {})
}

function stubBundle({ version = '__test_bundle__', body = { dim: 1, count: 1, chunks: [] }, bin = 'BIN' } = {}) {
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {} })
    const metaBuf = Buffer.from(JSON.stringify(body))
    const binBuf = Buffer.from(bin)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(metaBuf.length, 0)
    const frame = Buffer.concat([header, metaBuf, binBuf])
    return new Response(frame, {
      status: 200,
      headers: { etag: 'W/"seed"', 'x-embeddings-version': version, 'content-type': 'application/octet-stream' }
    })
  }
  return seen
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

    let condHeader = null
    globalThis.fetch = async (url, init = {}) => {
      condHeader = init.headers?.['If-None-Match']
      return new Response(null, { status: 304 })
    }
    const r = await downloadEmbeddings()
    assert.strictEqual(condHeader, 'W/"seed"')
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

    globalThis.fetch = async () => new Response(null, { status: 304 })
    const r = await downloadEmbeddings()
    assert.strictEqual(r.commitId, older, '304 must return stored version, not newest-local')
    assert.strictEqual(r.localDir, path.join(DEFAULT_EMBEDDINGS_DIR, older))

    // Cleanup.
    for (const v of [older, newer]) await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, v), { recursive: true, force: true }).catch(() => {})
  })

  test('throws when bundle 304 but etag file has no commitId', async () => {
    await fs.mkdir(path.dirname(manifestEtagPath), { recursive: true })
    await fs.writeFile(manifestEtagPath, JSON.stringify({ etag: 'W/"orphan"' }))
    globalThis.fetch = async () => new Response(null, { status: 304 })
    await assert.rejects(downloadEmbeddings(), /no commitId/)
  })

  test('throws when bundle 304 but the stored commit id dir is missing on disk', async () => {
    await fs.mkdir(path.dirname(manifestEtagPath), { recursive: true })
    await fs.writeFile(manifestEtagPath, JSON.stringify({ etag: 'W/"orphan"', commitId: '__gone__' }))
    await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, '__gone__'), { recursive: true, force: true }).catch(() => {})
    globalThis.fetch = async () => new Response(null, { status: 304 })
    await assert.rejects(downloadEmbeddings(), /missing files/)
  })

  test('throws when bundle response is non-OK', async () => {
    globalThis.fetch = async () => new Response(null, { status: 500, statusText: 'Server Err' })
    await assert.rejects(downloadEmbeddings(), /Failed to fetch bundle: 500/)
  })

  test('throws when bundle response lacks X-Embeddings-Version header', async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ dim: 0, count: 0, chunks: [], embeddings: Buffer.from('X').toString('base64') }),
      { status: 200, headers: { etag: 'W/"x"' } }
    )
    await assert.rejects(downloadEmbeddings(), /missing X-Embeddings-Version/)
  })

  test('throws when bundle frame is truncated (metaLen exceeds body)', async () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(9999, 0)
    globalThis.fetch = async () => new Response(
      Buffer.concat([header, Buffer.from('short')]),
      { status: 200, headers: { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' } }
    )
    await assert.rejects(downloadEmbeddings(), /framing/)
  })

  test('propagates fetch network error', async () => {
    globalThis.fetch = async () => { throw new TypeError('network down') }
    await assert.rejects(downloadEmbeddings(), /network down/)
  })

  test('when detection misses, etag lands under "latest" pseudo-version, never "unknown"', async () => {
    stubBundle({ version: testVer })

    const os = await import('node:os')
    const originalCwd = process.cwd()
    const newestEtag = path.join(DEFAULT_DIR, 'etags', 'latest', 'manifest.etag')
    const unknownEtag = path.join(DEFAULT_DIR, 'etags', 'unknown', 'manifest.etag')
    await fs.rm(path.join(DEFAULT_DIR, 'etags', 'latest'), { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(DEFAULT_DIR, 'etags', 'unknown'), { recursive: true, force: true }).catch(() => {})

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
      await fs.rm(path.join(DEFAULT_DIR, 'etags', 'latest'), { recursive: true, force: true }).catch(() => {})
      await fs.rm(path.join(DEFAULT_DIR, 'etags', 'unknown'), { recursive: true, force: true }).catch(() => {})
    }
  })

  test('concurrent downloadEmbeddings calls must be single-flighted', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    globalThis.fetch = async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, 30))
      concurrent--
      const meta = Buffer.from(JSON.stringify({ dim: 0, count: 0, chunks: [], model: 't' }))
      const header = Buffer.alloc(4)
      header.writeUInt32BE(meta.length, 0)
      const frame = Buffer.concat([header, meta, Buffer.from('BIN')])
      return new Response(frame, {
        status: 200,
        headers: { etag: 'W/"seed"', 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
      })
    }
    const results = await Promise.allSettled([downloadEmbeddings(), downloadEmbeddings()])
    const anyRejected = results.some(r => r.status === 'rejected')
    assert.ok(
      !anyRejected && maxConcurrent === 1,
      `downloadEmbeddings must serialize concurrent callers. maxConcurrent=${maxConcurrent}, rejected=${anyRejected}`
    )
  })

  test('metaLen leaving empty bin must reject as framing error, not corruption', async () => {
    const meta = Buffer.from(JSON.stringify({ dim: 1, count: 1, chunks: ['x'], model: 't' }))
    const header = Buffer.alloc(4)
    header.writeUInt32BE(meta.length, 0)
    const body = Buffer.concat([header, meta]) // zero bin bytes
    globalThis.fetch = async () => new Response(body, {
      status: 200,
      headers: { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
    })
    await assert.rejects(
      downloadEmbeddings(),
      /empty bin|framing|bin bytes/i,
      'must reject empty-bin frame with a framing error, not silently write it'
    )
  })

  test('body shorter than 4 bytes must reject as too short', async () => {
    globalThis.fetch = async () => new Response(Buffer.from([0x00, 0x01, 0x02]), {
      status: 200,
      headers: { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
    })
    await assert.rejects(downloadEmbeddings(), /too short/)
  })

  test('exactly-4-byte body (header only, metaLen=0) must reject as empty bin', async () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(0, 0)
    globalThis.fetch = async () => new Response(header, {
      status: 200,
      headers: { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
    })
    await assert.rejects(downloadEmbeddings(), /empty bin|framing|bin bytes/i)
  })

  test('frame with 1 bin byte must succeed', async () => {
    const meta = Buffer.from(JSON.stringify({ dim: 1, count: 1, chunks: ['x'], model: 't' }))
    const header = Buffer.alloc(4)
    header.writeUInt32BE(meta.length, 0)
    const bin = Buffer.from([0x01])
    const body = Buffer.concat([header, meta, bin])
    globalThis.fetch = async () => new Response(body, {
      status: 200,
      headers: { etag: 'W/"ok"', 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
    })
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
    const ep = path.join(DEFAULT_DIR, 'etags', cdsVer, 'manifest.etag')
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
    for (const v of testCdsDirs) await fs.rm(path.join(DEFAULT_DIR, 'etags', v), { recursive: true, force: true }).catch(() => {})
    for (const c of testCommits) await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, c), { recursive: true, force: true }).catch(() => {})
  })
  after(async () => {
    for (const v of testCdsDirs) await fs.rm(path.join(DEFAULT_DIR, 'etags', v), { recursive: true, force: true }).catch(() => {})
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
      const ep = path.join(DEFAULT_DIR, 'etags', dirs[i], 'manifest.etag')
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
      for (const v of dirs) await fs.rm(path.join(DEFAULT_DIR, 'etags', v), { recursive: true, force: true }).catch(() => {})
    }
  })
})
