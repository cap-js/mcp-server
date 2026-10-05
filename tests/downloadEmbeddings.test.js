import { test, describe, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import { installMemFs } from './helpers/mem-fs-mock.js'
import { mockFetch, bundle, manifest } from './helpers/mock-fetch.mjs'

process.env.CDS_MCP_OFFLINE = 'true'

const { downloadEmbeddings, resolveLocalVersion } = await import('../lib/searchMarkdownDocs.js')
const { getActiveModel, getActiveModelFolder, DEFAULT_DIR, toDirName } = await import('../lib/calculateEmbeddings.js')
const cds = (await import('@sap/cds')).default

const MODEL_FOLDER = getActiveModelFolder()
const DEFAULT_EMBEDDINGS_DIR = path.join(DEFAULT_DIR, MODEL_FOLDER)
const modelEtagsRoot = path.join(DEFAULT_DIR, MODEL_FOLDER, 'etags')
const manifestEtagPath = path.join(modelEtagsRoot, cds.version, 'manifest.etag')

describe('downloadEmbeddings (bundle endpoint)', () => {
  const testVer = '__test_bundle__'
  const testDir = path.join(DEFAULT_EMBEDDINGS_DIR, testVer)
  let mem

  // Fresh in-memory fs per test → clean slate under the embeddings dir.
  beforeEach(() => {
    mock.restoreAll()
    mem = installMemFs()
  })
  after(() => mock.restoreAll())

  // Group: 200 bundle, no prior FS state — all three share the same mock response.
  describe('200 bundle, no prior state', () => {
    let requests
    beforeEach(() => {
      requests = mockFetch(
        bundle.ok({
          version: testVer,
          body: { dim: 1, count: 1, chunks: ['hi'] },
          bin: Buffer.from(new Float32Array([1.5]).buffer)
        })
      )
    })

    test('sends cds and model query params', async () => {
      await downloadEmbeddings()
      const url = new URL(requests[0].url)
      assert.strictEqual(url.pathname.endsWith('/getEmbeddings'), true)
      assert.strictEqual(url.searchParams.get('cds'), cds.version)
      assert.strictEqual(url.searchParams.get('model'), MODEL_FOLDER)
    })

    test('200 response stamps lastChecked in etag file', async () => {
      const before = Date.now()
      await downloadEmbeddings()
      const saved = mem.readJson(manifestEtagPath)
      assert.ok(typeof saved.lastChecked === 'number', 'lastChecked must be written after a 200 download')
      assert.ok(saved.lastChecked >= before)
    })

    test('when detection misses, etag lands under "latest" pseudo-version, never "unknown"', async () => {
      const os = await import('node:os')
      const originalCwd = process.cwd()
      const newestEtag = path.join(modelEtagsRoot, 'latest', 'manifest.etag')
      const unknownEtag = path.join(modelEtagsRoot, 'unknown', 'manifest.etag')

      try {
        process.chdir(os.tmpdir())
        await downloadEmbeddings()

        assert.strictEqual(
          mem.exists(unknownEtag),
          false,
          'no etag file may be created under <DEFAULT_DIR>/etags/unknown/'
        )
        assert.ok(mem.exists(newestEtag), `etag must be written under "etags/latest" pseudo-version dir: ${newestEtag}`)

        const saved = mem.readJson(newestEtag)
        assert.strictEqual(saved.etag, 'W/"seed"', 'etag payload must match the bundle response header')
        assert.strictEqual(
          saved.commitId,
          testVer,
          'stored commitId must be the x-embeddings-version returned by the server'
        )
      } finally {
        process.chdir(originalCwd)
      }
    })

    test('writes versioned json + bin and returns updated=true', async () => {
      const r = await downloadEmbeddings()
      assert.strictEqual(r.updated, true)
      assert.strictEqual(r.commitId, testVer)

      const meta = mem.readJson(path.join(testDir, 'code-chunks.json'))
      assert.deepStrictEqual(meta.chunks, ['hi'])
      assert.strictEqual(meta.embeddings, undefined, 'embeddings field must be stripped from meta json')

      const bin = mem.readFile(path.join(testDir, 'code-chunks.bin'))
      assert.strictEqual(bin.length, 4, '1 chunk * 1 dim * 4 bytes')
    })

    test('persists etag+commitId, sends If-None-Match on next call, 304 → returns stored version dir', async () => {
      await downloadEmbeddings()
      const saved = mem.readJson(manifestEtagPath)
      assert.strictEqual(saved.etag, 'W/"seed"')
      assert.strictEqual(saved.commitId, testVer)

      // Stale lastChecked so the daily skip does not swallow the next call.
      mem.seedFile(manifestEtagPath, JSON.stringify({ ...saved, lastChecked: 0 }))

      requests = mockFetch(bundle.notModified())
      const r = await downloadEmbeddings()
      assert.strictEqual(requests[0].headers['If-None-Match'], 'W/"seed"')
      assert.strictEqual(r.updated, false)
      assert.strictEqual(r.commitId, testVer, '304 returns the commit id stored alongside the etag')
    })

    test('skips fetch when lastChecked is within 24h and local files exist', async () => {
      const etagData = {
        etag: 'W/"seed"',
        runtime: 'node',
        commitId: testVer,
        model: getActiveModel(),
        lastChecked: Date.now()
      }
      mem.seedFile(manifestEtagPath, JSON.stringify(etagData))
      mem.seedFile(path.join(testDir, 'code-chunks.json'), '{}')
      mem.seedFile(path.join(testDir, 'code-chunks.bin'), Buffer.alloc(0))

      const r = await downloadEmbeddings()
      assert.strictEqual(requests.length, 0, 'must not call fetch within daily window')
      assert.strictEqual(r.updated, false)
      assert.strictEqual(r.commitId, testVer)
    })

    test('daily skip falls through to fetch when local files are missing', async () => {
      const etagData = {
        etag: 'W/"seed"',
        commitId: testVer,
        model: getActiveModel(),
        lastChecked: Date.now()
      }
      mem.seedFile(manifestEtagPath, JSON.stringify(etagData))
      // testDir intentionally absent

      await downloadEmbeddings()
      assert.strictEqual(requests.length, 1, 'must fall through to fetch when local files are missing')
    })

    test('304 response stamps lastChecked in etag file', async () => {
      await downloadEmbeddings()
      // Stale lastChecked so the daily skip does not swallow the 304 call.
      const prev = mem.readJson(manifestEtagPath)
      mem.seedFile(manifestEtagPath, JSON.stringify({ ...prev, lastChecked: 0 }))
      const before = Date.now()
      mockFetch(bundle.notModified())
      await downloadEmbeddings()
      const saved = mem.readJson(manifestEtagPath)
      assert.ok(typeof saved.lastChecked === 'number', 'lastChecked must be written after a 304')
      assert.ok(saved.lastChecked >= before)
    })
  })

  // Group: 304 not modified — shares the same mock response.
  describe('304 not modified', () => {
    let requests
    beforeEach(() => {
      requests = mockFetch(bundle.notModified())
    })

    test('304 returns the stored commit id, not the newest local dir', async () => {
      // Seed two local versioned dirs — a newer one and an older one.
      const older = '__test_bundle_1.0.0__'
      const newer = '__test_bundle_9.9.9__'
      for (const v of [older, newer]) {
        const dir = path.join(DEFAULT_EMBEDDINGS_DIR, v)
        mem.seedFile(path.join(dir, 'code-chunks.json'), '{}')
        mem.seedFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))
      }
      // Etag file says: for THIS cds version, server would serve `older`.
      mem.seedFile(manifestEtagPath, JSON.stringify({ etag: 'W/"seed"', commitId: older }))

      const r = await downloadEmbeddings()
      assert.strictEqual(r.commitId, older, '304 must return stored version, not newest-local')
      assert.strictEqual(r.localDir, path.join(DEFAULT_EMBEDDINGS_DIR, older))
    })

    test('proceeds with fetch when lastChecked is stale (>24h)', async () => {
      const etagData = {
        etag: 'W/"seed"',
        commitId: testVer,
        model: getActiveModel(),
        lastChecked: Date.now() - 86_400_001
      }
      mem.seedFile(manifestEtagPath, JSON.stringify(etagData))
      mem.seedFile(path.join(testDir, 'code-chunks.json'), '{}')
      mem.seedFile(path.join(testDir, 'code-chunks.bin'), Buffer.alloc(0))

      await downloadEmbeddings()
      assert.ok(requests.length > 0, 'fetch must be called when lastChecked is stale')
    })

    test('throws when bundle 304 but etag file has no commitId', async () => {
      mem.seedFile(manifestEtagPath, JSON.stringify({ etag: 'W/"orphan"' }))
      await assert.rejects(downloadEmbeddings(), /no commitId/)
    })

    test('throws when bundle 304 but the stored commit id dir is missing on disk', async () => {
      mem.seedFile(manifestEtagPath, JSON.stringify({ etag: 'W/"orphan"', commitId: '__gone__' }))
      await assert.rejects(downloadEmbeddings(), /missing files/)
    })
  })

  test('throws when bundle response is non-OK', async () => {
    mockFetch(bundle.failed(500, 'Server Err'))
    await assert.rejects(downloadEmbeddings(), /Failed to fetch bundle: 500/)
  })

  test('non-OK error includes available models when manifest is reachable', async () => {
    mockFetch(
      bundle.failed(404, 'Not Found'),
      manifest.ok({
        'model-a': [{ model: 'model-a' }],
        'model-b': [{ model: 'model-b' }]
      })
    )
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /Failed to fetch bundle: 404/)
      assert.match(err.message, /Available models/)
      assert.match(err.message, /model-a/)
      return true
    })
  })

  test('non-OK error has no suffix when manifest is unreachable', async () => {
    mockFetch(bundle.failed(503, 'Unavailable'))
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /Failed to fetch bundle: 503/)
      assert.doesNotMatch(err.message, /Available models/)
      return true
    })
  })

  test('non-OK with x-embeddings-model header throws non-OK error, not model-mismatch', async () => {
    mockFetch(
      bundle.failed(400, 'Bad Request', {
        'x-embeddings-model': 'some--other-model'
      }),
      manifest.ok({})
    )
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
    mockFetch(
      bundle.okWrongModel({ version: testVer, wrongModel }),
      manifest.ok({ [correctModelFolderName]: [{ model: correctModelName }] })
    )
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
    mockFetch(bundle.okWrongModel({ version: testVer, wrongModel }), manifest.failed(503))
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /not found/)
      assert.doesNotMatch(err.message, /Available models/)
      return true
    })
  })

  test('throws when bundle response lacks X-Embeddings-Version header', async () => {
    mockFetch(
      bundle.okRaw(
        JSON.stringify({
          dim: 0,
          count: 0,
          chunks: [],
          embeddings: Buffer.from('X').toString('base64')
        }),
        { etag: 'W/"x"' }
      )
    )
    await assert.rejects(downloadEmbeddings(), /missing X-Embeddings-Version/)
  })

  test('throws when bundle frame is truncated (metaLen exceeds body)', async () => {
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(9999, 0)
    mockFetch(
      bundle.okRaw(Buffer.concat([hdr, Buffer.from('short')]), {
        'x-embeddings-version': testVer,
        'content-type': 'application/octet-stream'
      })
    )
    await assert.rejects(downloadEmbeddings(), /framing/)
  })

  // Group: network error — shares the same mock response.
  describe('network error', () => {
    beforeEach(() => {
      mockFetch(bundle.networkError('network down'))
    })

    test('falls back to local version on network error', async () => {
      mem.seedFile(
        manifestEtagPath,
        JSON.stringify({
          etag: 'W/"seed"',
          commitId: testVer,
          model: getActiveModel()
        })
      )
      mem.seedFile(path.join(testDir, 'code-chunks.json'), '{}')
      mem.seedFile(path.join(testDir, 'code-chunks.bin'), Buffer.alloc(0))

      const result = await downloadEmbeddings()
      assert.strictEqual(result.updated, false)
      assert.strictEqual(result.commitId, testVer)
      assert.strictEqual(result.localDir, testDir)
    })

    test('throws offline error (with network cause) when no local version exists', async () => {
      // Fresh in-memory store → nothing local, so resolveLocalVersion returns null.
      await assert.rejects(downloadEmbeddings(), err => {
        assert.match(err.message, /Offline mode/)
        assert.match(err.cause?.message, /network down/)
        return true
      })
    })
  })

  test('concurrent calls are serialized with at most one in-flight fetch', async () => {
    const c = bundle.okConcurrent(testVer)
    mockFetch(c)
    const results = await Promise.allSettled([downloadEmbeddings(), downloadEmbeddings()])
    const anyRejected = results.some(r => r.status === 'rejected')
    assert.ok(
      !anyRejected && c.tracking.maxConcurrent === 1,
      `downloadEmbeddings must serialize concurrent callers. maxConcurrent=${c.tracking.maxConcurrent}, rejected=${anyRejected}`
    )
  })

  test('frame with metaLen consuming all bytes and no bin bytes rejects as framing error', async () => {
    const meta = Buffer.from(JSON.stringify({ dim: 1, count: 1, chunks: ['x'], model: 't' }))
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(meta.length, 0)
    mockFetch(
      bundle.okRaw(Buffer.concat([hdr, meta]), {
        'x-embeddings-version': testVer,
        'content-type': 'application/octet-stream'
      })
    )
    await assert.rejects(
      downloadEmbeddings(),
      /empty bin|framing|bin bytes/i,
      'must reject empty-bin frame with a framing error, not silently write it'
    )
  })

  test('body shorter than 4 bytes rejects with "too short" error', async () => {
    mockFetch(
      bundle.okRaw(Buffer.from([0x00, 0x01, 0x02]), {
        'x-embeddings-version': testVer,
        'content-type': 'application/octet-stream'
      })
    )
    await assert.rejects(downloadEmbeddings(), /too short/)
  })

  test('exactly-4-byte body with metaLen=0 rejects as empty bin', async () => {
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(0, 0)
    mockFetch(
      bundle.okRaw(hdr, {
        'x-embeddings-version': testVer,
        'content-type': 'application/octet-stream'
      })
    )
    await assert.rejects(downloadEmbeddings(), /empty bin|framing|bin bytes/i)
  })

  test('frame with 1 bin byte writes the byte and returns updated=true', async () => {
    const meta = Buffer.from(JSON.stringify({ dim: 1, count: 1, chunks: ['x'], model: 't' }))
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(meta.length, 0)
    mockFetch(
      bundle.okRaw(Buffer.concat([hdr, meta, Buffer.from([0x01])]), {
        etag: 'W/"ok"',
        'x-embeddings-version': testVer,
        'content-type': 'application/octet-stream'
      })
    )
    const r = await downloadEmbeddings()
    assert.strictEqual(r.updated, true)
    const written = mem.readFile(path.join(DEFAULT_EMBEDDINGS_DIR, testVer, 'code-chunks.bin'))
    assert.strictEqual(written.length, 1)
    assert.strictEqual(written[0], 0x01)
  })
})

describe('resolveLocalVersion', () => {
  const testCommits = ['__local_commit_a__', '__local_commit_b__', '__local_commit_c__']
  let mem

  beforeEach(() => {
    mock.restoreAll()
    mem = installMemFs()
  })
  after(() => mock.restoreAll())

  function seedEtag(cdsVer, commitId) {
    const ep = path.join(modelEtagsRoot, cdsVer, 'manifest.etag')
    mem.seedFile(ep, JSON.stringify({ etag: 'W/"x"', commitId }))
    return ep
  }
  function seedEmbedDir(commitId, complete = true) {
    const dir = path.join(DEFAULT_EMBEDDINGS_DIR, commitId)
    mem.seedFile(path.join(dir, 'code-chunks.json'), '{}')
    if (complete) mem.seedFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))
    return dir
  }

  test('returns commitId from etag and skips incomplete embed dirs', async () => {
    // complete dir for commit_a, incomplete for commit_b
    seedEmbedDir(testCommits[0])
    seedEmbedDir(testCommits[1], false) // missing .bin
    seedEtag('1.0.0', testCommits[0])
    seedEtag('2.5.0', testCommits[1])

    const local = await resolveLocalVersion()
    assert.ok(local)
    // commit_b's dir is incomplete → must resolve to commit_a (only complete one)
    assert.strictEqual(local.commitId, testCommits[0])
    assert.strictEqual(local.localDir, path.join(DEFAULT_EMBEDDINGS_DIR, testCommits[0]))
    assert.ok(mem.exists(path.join(local.localDir, 'code-chunks.json')))
    assert.ok(mem.exists(path.join(local.localDir, 'code-chunks.bin')))
  })

  test('among two cds versions with complete dirs, returns commitId from highest cds version', async () => {
    seedEmbedDir(testCommits[0])
    seedEmbedDir(testCommits[1])
    seedEtag('1.0.0', testCommits[0])
    seedEtag('2.10.0', testCommits[1])

    const local = await resolveLocalVersion()
    assert.strictEqual(local.commitId, testCommits[1], 'must pick commitId from highest semver cds dir')
  })

  test('among non-semver cds dirs, tiebreaks by mtime not readdir order', async () => {
    const dirs = ['bundle_alpha', 'bundle_beta']
    seedEmbedDir(testCommits[0])
    seedEmbedDir(testCommits[1])
    // seed etag files under non-semver dir names
    for (let i = 0; i < dirs.length; i++) {
      mem.seedFile(
        path.join(modelEtagsRoot, dirs[i], 'manifest.etag'),
        JSON.stringify({ etag: 'W/"x"', commitId: testCommits[i] })
      )
    }
    const now = Date.now()
    // control mtime on the embed dirs themselves — last-resort uses those, not etag dirs
    mem.setMtime(path.join(DEFAULT_EMBEDDINGS_DIR, testCommits[0]), now - 100000)
    mem.setMtime(path.join(DEFAULT_EMBEDDINGS_DIR, testCommits[1]), now)
    // both etag dirs have non-semver names → semver scan skips them → fall through to mtime last-resort
    const local = await resolveLocalVersion()
    assert.ok(local, 'last-resort must find a complete embed dir')
    assert.strictEqual(local.commitId, testCommits[1], 'must pick newer embed dir by mtime')
  })

  test('picks etag under "latest" pseudo dir when no semver dirs match', async () => {
    seedEmbedDir(testCommits[0])
    // Seed etag under UNKNOWN_CDS_VERSION pseudo dir only.
    mem.seedFile(
      path.join(modelEtagsRoot, 'latest', 'manifest.etag'),
      JSON.stringify({ etag: 'W/"x"', commitId: testCommits[0] })
    )

    const local = await resolveLocalVersion()
    assert.ok(local)
    assert.strictEqual(local.commitId, testCommits[0], 'must fall back to pseudo dir etag')
  })

  test('real semver dir beats "latest" pseudo dir', async () => {
    seedEmbedDir(testCommits[0])
    seedEmbedDir(testCommits[1])
    // pseudo → commit_a; real semver → commit_b. Real wins.
    mem.seedFile(
      path.join(modelEtagsRoot, 'latest', 'manifest.etag'),
      JSON.stringify({ etag: 'W/"x"', commitId: testCommits[0] })
    )
    seedEtag('1.0.0', testCommits[1])

    const local = await resolveLocalVersion()
    assert.strictEqual(local.commitId, testCommits[1], 'real semver must beat pseudo dir')
  })

  test('last-resort scan skips the etags subdir inside a model folder', async () => {
    // Seed only the etags dir (no commit dirs), plus one real commit dir.
    seedEmbedDir(testCommits[0])
    // Etag file has NO commitId — pseudo route can't return anything.
    mem.seedFile(path.join(modelEtagsRoot, 'latest', 'manifest.etag'), JSON.stringify({ etag: 'W/"x"' }))

    const local = await resolveLocalVersion()
    // Must find real commit dir via last-resort; must NOT return 'etags' as commitId.
    assert.ok(local)
    assert.strictEqual(local.commitId, testCommits[0], 'last-resort must skip inner etags/ dir')
    assert.notStrictEqual(local.commitId, 'etags')
  })
})
