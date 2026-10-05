import { test, describe, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import fsp from 'node:fs/promises'
import { remapFs } from './helpers/remap-fs.js'

function frame(body, bin) {
  const metaBuf = Buffer.from(JSON.stringify(body))
  const binBuf = Buffer.isBuffer(bin) ? bin : Buffer.from(bin)
  const hdr = Buffer.alloc(4)
  hdr.writeUInt32BE(metaBuf.length, 0)
  return Buffer.concat([hdr, metaBuf, binBuf])
}

process.env.CDS_MCP_OFFLINE = 'true'

const { downloadEmbeddings, resolveLocalVersion } = await import('../lib/searchMarkdownDocs.js')
const { getActiveModel, getActiveModelFolder, getActiveEmbeddingsDir, toDirName } =
  await import('../lib/calculateEmbeddings.js')
const cds = (await import('@sap/cds')).default

const MODEL_FOLDER = getActiveModelFolder()
const DEFAULT_EMBEDDINGS_DIR = getActiveEmbeddingsDir()
const modelEtagsRoot = path.join(getActiveEmbeddingsDir(), 'etags')
const manifestEtagPath = path.join(getActiveEmbeddingsDir(), 'etags', cds.version, 'manifest.etag')

describe('downloadEmbeddings (bundle endpoint)', () => {
  const testVer = '__test_bundle__'
  const testDir = path.join(DEFAULT_EMBEDDINGS_DIR, testVer)

  // Fresh in-memory fs per test → clean slate under the embeddings dir.
  beforeEach(() => {
    mock.restoreAll()
    remapFs()
  })
  after(() => mock.restoreAll())

  // Group: 200 bundle, no prior FS state — all three share the same mock response.
  describe('200 bundle, no prior state', () => {
    let requests
    beforeEach(() => {
      requests = []
      mock.method(globalThis, 'fetch', async (url, init = {}) => {
        requests.push({ url: String(url), headers: init.headers || {} })
        return new Response(frame({ dim: 1, count: 1, chunks: ['hi'] }, Buffer.from(new Float32Array([1.5]).buffer)), {
          status: 200,
          headers: { etag: 'W/"seed"', 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
        })
      })
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
      const saved = JSON.parse(await fsp.readFile(manifestEtagPath, 'utf-8'))
      assert.ok(typeof saved.lastChecked === 'number', 'lastChecked must be written after a 200 download')
      assert.ok(saved.lastChecked >= before)
    })

    test('when detection misses, etag lands under "latest" pseudo-version, never "unknown"', async () => {
      const newestEtag = path.join(modelEtagsRoot, 'latest', 'manifest.etag')
      const unknownEtag = path.join(modelEtagsRoot, 'unknown', 'manifest.etag')
      const savedVersion = cds.version

      try {
        cds.version = undefined
        await downloadEmbeddings()

        assert.strictEqual(
          await fsp.access(unknownEtag).then(() => true, () => false),
          false,
          'no etag file may be created under <DEFAULT_DIR>/etags/unknown/'
        )
        assert.ok(await fsp.access(newestEtag).then(() => true, () => false), `etag must be written under "etags/latest" pseudo-version dir: ${newestEtag}`)

        const saved = JSON.parse(await fsp.readFile(newestEtag, 'utf-8'))
        assert.strictEqual(saved.etag, 'W/"seed"', 'etag payload must match the bundle response header')
        assert.strictEqual(
          saved.commitId,
          testVer,
          'stored commitId must be the x-embeddings-version returned by the server'
        )
      } finally {
        cds.version = savedVersion
      }
    })

    test('writes versioned json + bin and returns updated=true', async () => {
      const r = await downloadEmbeddings()
      assert.strictEqual(r.updated, true)
      assert.strictEqual(r.commitId, testVer)

      const meta = JSON.parse(await fsp.readFile(path.join(testDir, 'code-chunks.json'), 'utf-8'))
      assert.deepStrictEqual(meta.chunks, ['hi'])
      assert.strictEqual(meta.embeddings, undefined, 'embeddings field must be stripped from meta json')

      const bin = await fsp.readFile(path.join(testDir, 'code-chunks.bin'))
      assert.strictEqual(bin.length, 4, '1 chunk * 1 dim * 4 bytes')
    })

    test('persists etag+commitId, sends If-None-Match on next call, 304 → returns stored version dir', async () => {
      await downloadEmbeddings()
      const saved = JSON.parse(await fsp.readFile(manifestEtagPath, 'utf-8'))
      assert.strictEqual(saved.etag, 'W/"seed"')
      assert.strictEqual(saved.commitId, testVer)

      // Stale lastChecked so the daily skip does not swallow the next call.
      await fsp.writeFile(manifestEtagPath, JSON.stringify({ ...saved, lastChecked: 0 }))

      requests = []
      mock.method(globalThis, 'fetch', async (url, init = {}) => {
        requests.push({ url: String(url), headers: init.headers || {} })
        return new Response(null, { status: 304 })
      })
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
      await fsp.writeFile(manifestEtagPath, JSON.stringify(etagData))
      await fsp.writeFile(path.join(testDir, 'code-chunks.json'), '{}')
      await fsp.writeFile(path.join(testDir, 'code-chunks.bin'), Buffer.alloc(0))

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
      await fsp.writeFile(manifestEtagPath, JSON.stringify(etagData))
      // testDir intentionally absent

      await downloadEmbeddings()
      assert.strictEqual(requests.length, 1, 'must fall through to fetch when local files are missing')
    })

    test('304 response stamps lastChecked in etag file', async () => {
      await downloadEmbeddings()
      // Stale lastChecked so the daily skip does not swallow the 304 call.
      const prev = JSON.parse(await fsp.readFile(manifestEtagPath, 'utf-8'))
      await fsp.writeFile(manifestEtagPath, JSON.stringify({ ...prev, lastChecked: 0 }))
      const before = Date.now()
      mock.method(globalThis, 'fetch', async () => new Response(null, { status: 304 }))
      await downloadEmbeddings()
      const saved = JSON.parse(await fsp.readFile(manifestEtagPath, 'utf-8'))
      assert.ok(typeof saved.lastChecked === 'number', 'lastChecked must be written after a 304')
      assert.ok(saved.lastChecked >= before)
    })
  })

  // Group: 304 not modified — shares the same mock response.
  describe('304 not modified', () => {
    let requests
    beforeEach(() => {
      requests = []
      mock.method(globalThis, 'fetch', async (url, init = {}) => {
        requests.push({ url: String(url), headers: init.headers || {} })
        return new Response(null, { status: 304 })
      })
    })

    test('304 returns the stored commit id, not the newest local dir', async () => {
      // Seed two local versioned dirs — a newer one and an older one.
      const older = '__test_bundle_1.0.0__'
      const newer = '__test_bundle_9.9.9__'
      for (const v of [older, newer]) {
        const dir = path.join(DEFAULT_EMBEDDINGS_DIR, v)
        await fsp.writeFile(path.join(dir, 'code-chunks.json'), '{}')
        await fsp.writeFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))
      }
      // Etag file says: for THIS cds version, server would serve `older`.
      await fsp.writeFile(manifestEtagPath, JSON.stringify({ etag: 'W/"seed"', commitId: older }))

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
      await fsp.writeFile(manifestEtagPath, JSON.stringify(etagData))
      await fsp.writeFile(path.join(testDir, 'code-chunks.json'), '{}')
      await fsp.writeFile(path.join(testDir, 'code-chunks.bin'), Buffer.alloc(0))

      await downloadEmbeddings()
      assert.ok(requests.length > 0, 'fetch must be called when lastChecked is stale')
    })

    test('throws when bundle 304 but etag file has no commitId', async () => {
      await fsp.writeFile(manifestEtagPath, JSON.stringify({ etag: 'W/"orphan"' }))
      await assert.rejects(downloadEmbeddings(), /no commitId/)
    })

    test('throws when bundle 304 but the stored commit id dir is missing on disk', async () => {
      await fsp.writeFile(manifestEtagPath, JSON.stringify({ etag: 'W/"orphan"', commitId: '__gone__' }))
      await assert.rejects(downloadEmbeddings(), /missing files/)
    })
  })

  test('throws when bundle response is non-OK', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500, statusText: 'Server Err' }))
    await assert.rejects(downloadEmbeddings(), /Failed to fetch bundle: 500/)
  })

  test('non-OK error includes available models when manifest is reachable', async () => {
    mock.method(globalThis, 'fetch', async (url) => {
      if (new URL(String(url)).pathname.endsWith('/manifest.json')) {
        return new Response(
          JSON.stringify({ 'model-a': [{ model: 'model-a' }], 'model-b': [{ model: 'model-b' }] }),
          { status: 200 }
        )
      }
      return new Response(null, { status: 404, statusText: 'Not Found' })
    })
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /Failed to fetch bundle: 404/)
      assert.match(err.message, /Available models/)
      assert.match(err.message, /model-a/)
      return true
    })
  })

  test('server 404 problem+json (model not found) includes available models from manifest', async () => {
    mock.method(globalThis, 'fetch', async (url) => {
      if (new URL(String(url)).pathname.endsWith('/manifest.json')) {
        return new Response(JSON.stringify({ 'model-a': [{ model: 'model-a' }] }), { status: 200 })
      }
      const activeModel = getActiveModel()
      return new Response(
        JSON.stringify({ title: 'Model Not Found', status: 404, detail: `Model not found: ${activeModel}`, model: activeModel }),
        { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/problem+json' } }
      )
    })
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /Failed to fetch bundle: 404/)
      assert.match(err.message, /Available models/)
      assert.match(err.message, /model-a/)
      return true
    })
  })

  test('non-OK error has no suffix when manifest is unreachable', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503, statusText: 'Unavailable' }))
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /Failed to fetch bundle: 503/)
      assert.doesNotMatch(err.message, /Available models/)
      return true
    })
  })

  test('non-OK with x-embeddings-model header throws non-OK error, not model-mismatch', async () => {
    mock.method(globalThis, 'fetch', async (url) => {
      if (new URL(String(url)).pathname.endsWith('/manifest.json')) {
        return new Response(JSON.stringify({}), { status: 200 })
      }
      return new Response(null, {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'x-embeddings-model': 'some--other-model' }
      })
    })
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
    mock.method(globalThis, 'fetch', async (url) => {
      if (new URL(String(url)).pathname.endsWith('/manifest.json')) {
        return new Response(
          JSON.stringify({ [correctModelFolderName]: [{ model: correctModelName }] }),
          { status: 200 }
        )
      }
      return new Response(frame({ dim: 1, count: 0, chunks: [], model: 't' }, 'B'), {
        status: 200,
        headers: { etag: 'W/"x"', 'x-embeddings-version': testVer, 'x-embeddings-model': wrongModel }
      })
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
    mock.method(globalThis, 'fetch', async (url) => {
      if (new URL(String(url)).pathname.endsWith('/manifest.json')) {
        return new Response(null, { status: 503 })
      }
      return new Response(frame({ dim: 1, count: 0, chunks: [], model: 't' }, 'B'), {
        status: 200,
        headers: { etag: 'W/"x"', 'x-embeddings-version': testVer, 'x-embeddings-model': wrongModel }
      })
    })
    await assert.rejects(downloadEmbeddings(), err => {
      assert.match(err.message, /not found/)
      assert.doesNotMatch(err.message, /Available models/)
      return true
    })
  })

  test('throws when bundle response lacks X-Embeddings-Version header', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response(
        JSON.stringify({ dim: 0, count: 0, chunks: [], embeddings: Buffer.from('X').toString('base64') }),
        { status: 200, headers: { etag: 'W/"x"' } }
      )
    )
    await assert.rejects(downloadEmbeddings(), /missing X-Embeddings-Version/)
  })

  test('throws when bundle frame is truncated (metaLen exceeds body)', async () => {
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(9999, 0)
    mock.method(globalThis, 'fetch', async () =>
      new Response(Buffer.concat([hdr, Buffer.from('short')]), {
        status: 200,
        headers: { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
      })
    )
    await assert.rejects(downloadEmbeddings(), /framing/)
  })

  // Group: network error — shares the same mock response.
  describe('network error', () => {
    beforeEach(() => {
      mock.method(globalThis, 'fetch', async () => { throw new TypeError('network down') })
    })

    test('falls back to local version on network error', async () => {
      await fsp.writeFile(
        manifestEtagPath,
        JSON.stringify({
          etag: 'W/"seed"',
          commitId: testVer,
          model: getActiveModel()
        })
      )
      await fsp.writeFile(path.join(testDir, 'code-chunks.json'), '{}')
      await fsp.writeFile(path.join(testDir, 'code-chunks.bin'), Buffer.alloc(0))

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
    let concurrent = 0
    const tracking = { maxConcurrent: 0 }
    mock.method(globalThis, 'fetch', async () => {
      concurrent++
      tracking.maxConcurrent = Math.max(tracking.maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, 30))
      concurrent--
      return new Response(frame({ dim: 0, count: 0, chunks: [], model: 't' }, 'BIN'), {
        status: 200,
        headers: { etag: 'W/"seed"', 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
      })
    })
    const results = await Promise.allSettled([downloadEmbeddings(), downloadEmbeddings()])
    const anyRejected = results.some(r => r.status === 'rejected')
    assert.ok(
      !anyRejected && tracking.maxConcurrent === 1,
      `downloadEmbeddings must serialize concurrent callers. maxConcurrent=${tracking.maxConcurrent}, rejected=${anyRejected}`
    )
  })

  test('frame with metaLen consuming all bytes and no bin bytes rejects as framing error', async () => {
    const meta = Buffer.from(JSON.stringify({ dim: 1, count: 1, chunks: ['x'], model: 't' }))
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(meta.length, 0)
    mock.method(globalThis, 'fetch', async () =>
      new Response(Buffer.concat([hdr, meta]), {
        status: 200,
        headers: { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
      })
    )
    await assert.rejects(
      downloadEmbeddings(),
      /empty bin|framing|bin bytes/i,
      'must reject empty-bin frame with a framing error, not silently write it'
    )
  })

  test('body shorter than 4 bytes rejects with "too short" error', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response(Buffer.from([0x00, 0x01, 0x02]), {
        status: 200,
        headers: { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
      })
    )
    await assert.rejects(downloadEmbeddings(), /too short/)
  })

  test('exactly-4-byte body with metaLen=0 rejects as empty bin', async () => {
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(0, 0)
    mock.method(globalThis, 'fetch', async () =>
      new Response(hdr, {
        status: 200,
        headers: { 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
      })
    )
    await assert.rejects(downloadEmbeddings(), /empty bin|framing|bin bytes/i)
  })

  test('frame with 1 bin byte writes the byte and returns updated=true', async () => {
    const meta = Buffer.from(JSON.stringify({ dim: 1, count: 1, chunks: ['x'], model: 't' }))
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(meta.length, 0)
    mock.method(globalThis, 'fetch', async () =>
      new Response(Buffer.concat([hdr, meta, Buffer.from([0x01])]), {
        status: 200,
        headers: { etag: 'W/"ok"', 'x-embeddings-version': testVer, 'content-type': 'application/octet-stream' }
      })
    )
    const r = await downloadEmbeddings()
    assert.strictEqual(r.updated, true)
    const written = await fsp.readFile(path.join(DEFAULT_EMBEDDINGS_DIR, testVer, 'code-chunks.bin'))
    assert.strictEqual(written.length, 1)
    assert.strictEqual(written[0], 0x01)
  })
})

describe('resolveLocalVersion', () => {
  const testCommits = ['__local_commit_a__', '__local_commit_b__', '__local_commit_c__']
  let tmpEmbeddingsDir

  beforeEach(() => {
    mock.restoreAll()
    tmpEmbeddingsDir = remapFs()
  })
  after(() => mock.restoreAll())

  async function seedEtag(cdsVer, commitId) {
    const ep = path.join(modelEtagsRoot, cdsVer, 'manifest.etag')
    await fsp.writeFile(ep, JSON.stringify({ etag: 'W/"x"', commitId }))
    return ep
  }
  async function seedEmbedDir(commitId, complete = true) {
    const dir = path.join(DEFAULT_EMBEDDINGS_DIR, commitId)
    await fsp.writeFile(path.join(dir, 'code-chunks.json'), '{}')
    if (complete) await fsp.writeFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))
    return dir
  }

  test('returns commitId from etag and skips incomplete embed dirs', async () => {
    // complete dir for commit_a, incomplete for commit_b
    await seedEmbedDir(testCommits[0])
    await seedEmbedDir(testCommits[1], false) // missing .bin
    await seedEtag('1.0.0', testCommits[0])
    await seedEtag('2.5.0', testCommits[1])

    const local = await resolveLocalVersion()
    assert.ok(local)
    // commit_b's dir is incomplete → must resolve to commit_a (only complete one)
    assert.strictEqual(local.commitId, testCommits[0])
    assert.strictEqual(local.localDir, path.join(DEFAULT_EMBEDDINGS_DIR, testCommits[0]))
    assert.ok(await fsp.access(path.join(local.localDir, 'code-chunks.json')).then(() => true, () => false))
    assert.ok(await fsp.access(path.join(local.localDir, 'code-chunks.bin')).then(() => true, () => false))
  })

  test('among two cds versions with complete dirs, returns commitId from highest cds version', async () => {
    await seedEmbedDir(testCommits[0])
    await seedEmbedDir(testCommits[1])
    await seedEtag('1.0.0', testCommits[0])
    await seedEtag('2.10.0', testCommits[1])

    const local = await resolveLocalVersion()
    assert.strictEqual(local.commitId, testCommits[1], 'must pick commitId from highest semver cds dir')
  })

  test('among non-semver cds dirs, tiebreaks by mtime not readdir order', async () => {
    const dirs = ['bundle_alpha', 'bundle_beta']
    await seedEmbedDir(testCommits[0])
    await seedEmbedDir(testCommits[1])
    // seed etag files under non-semver dir names
    for (let i = 0; i < dirs.length; i++) {
      await fsp.writeFile(
        path.join(modelEtagsRoot, dirs[i], 'manifest.etag'),
        JSON.stringify({ etag: 'W/"x"', commitId: testCommits[i] })
      )
    }
    const now = Date.now()
    // control mtime on the embed dirs themselves — last-resort uses those, not etag dirs
    const real0 = path.join(tmpEmbeddingsDir, path.join(DEFAULT_EMBEDDINGS_DIR, testCommits[0]).slice(1))
    const real1 = path.join(tmpEmbeddingsDir, path.join(DEFAULT_EMBEDDINGS_DIR, testCommits[1]).slice(1))
    await fsp.utimes(real0, new Date(now - 100000), new Date(now - 100000))
    await fsp.utimes(real1, new Date(now), new Date(now))
    // both etag dirs have non-semver names → semver scan skips them → fall through to mtime last-resort
    const local = await resolveLocalVersion()
    assert.ok(local, 'last-resort must find a complete embed dir')
    assert.strictEqual(local.commitId, testCommits[1], 'must pick newer embed dir by mtime')
  })

  test('picks etag under "latest" pseudo dir when no semver dirs match', async () => {
    await seedEmbedDir(testCommits[0])
    // Seed etag under UNKNOWN_CDS_VERSION pseudo dir only.
    await fsp.writeFile(
      path.join(modelEtagsRoot, 'latest', 'manifest.etag'),
      JSON.stringify({ etag: 'W/"x"', commitId: testCommits[0] })
    )

    const local = await resolveLocalVersion()
    assert.ok(local)
    assert.strictEqual(local.commitId, testCommits[0], 'must fall back to pseudo dir etag')
  })

  test('real semver dir beats "latest" pseudo dir', async () => {
    await seedEmbedDir(testCommits[0])
    await seedEmbedDir(testCommits[1])
    // pseudo → commit_a; real semver → commit_b. Real wins.
    await fsp.writeFile(
      path.join(modelEtagsRoot, 'latest', 'manifest.etag'),
      JSON.stringify({ etag: 'W/"x"', commitId: testCommits[0] })
    )
    await seedEtag('1.0.0', testCommits[1])

    const local = await resolveLocalVersion()
    assert.strictEqual(local.commitId, testCommits[1], 'real semver must beat pseudo dir')
  })

  test('last-resort scan skips the etags subdir inside a model folder', async () => {
    // Seed only the etags dir (no commit dirs), plus one real commit dir.
    await seedEmbedDir(testCommits[0])
    // Etag file has NO commitId — pseudo route can't return anything.
    await fsp.writeFile(path.join(modelEtagsRoot, 'latest', 'manifest.etag'), JSON.stringify({ etag: 'W/"x"' }))

    const local = await resolveLocalVersion()
    // Must find real commit dir via last-resort; must NOT return 'etags' as commitId.
    assert.ok(local)
    assert.strictEqual(local.commitId, testCommits[0], 'last-resort must skip inner etags/ dir')
    assert.notStrictEqual(local.commitId, 'etags')
  })
})
