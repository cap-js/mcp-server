import { test, describe, after, before, beforeEach } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import fs from 'fs/promises'
import { getManifestEtagPath, installFetch } from './helpers/testBundle.js'

process.env.CDS_MCP_OFFLINE = 'true'

const { downloadEmbeddings } = await import('../lib/searchMarkdownDocs.js')
const {
  DEFAULT_DIR,
  setActiveModel,
  getActiveModel,
  getActiveModelFolder,
  getActiveEmbeddingsDir,
  toDirName
} = await import('../lib/calculateEmbeddings.js')

const DEFAULT_MODEL = getActiveModel()
const MODEL_FOLDER = toDirName(DEFAULT_MODEL)
const DEFAULT_EMBEDDINGS_DIR = path.join(DEFAULT_DIR, MODEL_FOLDER)

const originalFetch = globalThis.fetch
const defaultEtagPath = getManifestEtagPath()  // for the module-default model

let _savedEtag = null
before(async () => { _savedEtag = await fs.readFile(defaultEtagPath, 'utf-8').catch(() => null) })
after(async () => {
  globalThis.fetch = originalFetch
  setActiveModel()
  if (_savedEtag !== null) {
    await fs.mkdir(path.dirname(defaultEtagPath), { recursive: true })
    await fs.writeFile(defaultEtagPath, _savedEtag)
  } else {
    await fs.rm(path.dirname(defaultEtagPath), { recursive: true, force: true }).catch(() => {})
  }
})

describe('active model config', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
    setActiveModel()
  })

  test('default active model equals module default', () => {
    setActiveModel()
    assert.strictEqual(getActiveModel(), DEFAULT_MODEL)
    assert.strictEqual(getActiveModelFolder(), MODEL_FOLDER)
    assert.strictEqual(getActiveEmbeddingsDir(), DEFAULT_EMBEDDINGS_DIR)
  })

  test('setActiveModel switches folder + dir; empty resets to default', () => {
    setActiveModel('foo/bar')
    assert.strictEqual(getActiveModel(), 'foo/bar')
    assert.strictEqual(getActiveModelFolder(), 'foo--bar')
    assert.strictEqual(getActiveEmbeddingsDir(), path.join(DEFAULT_DIR, 'foo--bar'))

    setActiveModel('')
    assert.strictEqual(getActiveModel(), DEFAULT_MODEL, 'empty string must reset to default')

    setActiveModel(undefined)
    assert.strictEqual(getActiveModel(), DEFAULT_MODEL, 'undefined must reset to default')
  })

  test('toDirName escapes slashes', () => {
    assert.strictEqual(toDirName('org/name/sub'), 'org--name--sub')
    assert.strictEqual(toDirName('single'), 'single')
  })

  test('fromDirName reverses toDirName', async () => {
    const { fromDirName } = await import('../lib/calculateEmbeddings.js')
    assert.strictEqual(fromDirName('org--name'), 'org/name')
    assert.strictEqual(fromDirName('org--name--sub'), 'org/name/sub')
    assert.strictEqual(fromDirName('single'), 'single')
  })
})

describe('active model wiring into download', () => {
  const testVer = '__test_model_bundle__'

  beforeEach(async () => {
    globalThis.fetch = originalFetch
    setActiveModel()
    // Clean etag dirs for both default and 'foo--bar' scopes.
    await fs.rm(path.join(DEFAULT_DIR, MODEL_FOLDER, 'etags'), { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(DEFAULT_DIR, 'foo--bar', 'etags'), { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, testVer), { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(DEFAULT_DIR, 'foo--bar', testVer), { recursive: true, force: true }).catch(() => {})
  })
  after(async () => {
    await fs.rm(path.join(DEFAULT_EMBEDDINGS_DIR, testVer), { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(DEFAULT_DIR, 'foo--bar'), { recursive: true, force: true }).catch(() => {})
  })

  test('bundle URL model= param reflects active model', async () => {
    setActiveModel('foo/bar')
    const seen = installFetch({ version: testVer, model: 'foo/bar' })
    await downloadEmbeddings()
    const url = new URL(seen[0].url)
    assert.strictEqual(url.searchParams.get('model'), 'foo--bar')
  })

  test('server returns different model → throws with available models listed', async () => {
    setActiveModel('foo/bar')
    installFetch({
      version: testVer,
      model: DEFAULT_MODEL,
      manifest: ['sentence-transformers/all-MiniLM-L6-v2', 'Xenova/all-MiniLM-L6-v2']
    })

    await assert.rejects(
      downloadEmbeddings(),
      err => /Requested model "foo\/bar" not found/.test(err.message)
        && /sentence-transformers\/all-MiniLM-L6-v2/.test(err.message)
        && /Xenova\/all-MiniLM-L6-v2/.test(err.message)
    )
  })

  test('manifest fetch failure → still throws, without Available list', async () => {
    setActiveModel('foo/bar')
    installFetch({ version: testVer, model: DEFAULT_MODEL, manifestStatus: 500 })

    await assert.rejects(
      downloadEmbeddings(),
      err => /Requested model "foo\/bar" not found/.test(err.message)
        && !/Available models/.test(err.message)
    )
  })

  test('no throw when server model matches requested', async () => {
    setActiveModel('foo/bar')
    installFetch({ version: testVer, model: 'foo/bar' })
    await downloadEmbeddings()  // must not throw
  })

  test('switching active model reads different etag path → no If-None-Match sent', async () => {
    // Seed etag under DEFAULT model's dir, then switch to foo/bar → different etag scope,
    // download must not carry the default's If-None-Match.
    await fs.mkdir(path.dirname(defaultEtagPath), { recursive: true })
    await fs.writeFile(defaultEtagPath, JSON.stringify({ etag: 'W/"seed"', commitId: testVer, model: DEFAULT_MODEL }))

    setActiveModel('foo/bar')
    const seen = installFetch({ version: testVer, model: 'foo/bar' })
    await downloadEmbeddings()

    assert.strictEqual(seen[0].headers['If-None-Match'], undefined, 'active model uses its own etag scope')
  })

  test('etag under active model dir → 304 path returns cached dir', async () => {
    setActiveModel('foo/bar')
    const activeEtagPath = getManifestEtagPath()  // now points at foo--bar/<cds>/manifest.etag
    await fs.mkdir(path.dirname(activeEtagPath), { recursive: true })
    await fs.writeFile(activeEtagPath, JSON.stringify({ etag: 'W/"seed"', commitId: testVer, model: 'foo/bar' }))

    const dir = path.join(DEFAULT_DIR, 'foo--bar', testVer)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'code-chunks.json'), '{}')
    await fs.writeFile(path.join(dir, 'code-chunks.bin'), Buffer.alloc(0))

    const seen = installFetch({ notModified: true })

    const r = await downloadEmbeddings()
    assert.strictEqual(seen[0].headers['If-None-Match'], 'W/"seed"')
    assert.strictEqual(r.updated, false)
    assert.strictEqual(r.commitId, testVer)

    await fs.rm(path.join(DEFAULT_DIR, 'foo--bar', testVer), { recursive: true, force: true }).catch(() => {})
  })

  test('written etag records active model when server omits x-embeddings-model header', async () => {
    setActiveModel('foo/bar')
    installFetch({ version: testVer })  // no model header

    await downloadEmbeddings()

    const activeEtagPath = getManifestEtagPath()
    const saved = JSON.parse(await fs.readFile(activeEtagPath, 'utf-8'))
    assert.strictEqual(saved.model, 'foo/bar', 'must persist active model as fallback')
  })

  test('mismatch throw hits /manifest.json for available list', async () => {
    setActiveModel('foo/bar')
    const seen = installFetch({
      version: testVer,
      model: DEFAULT_MODEL,
      manifest: ['a/b']
    })

    await assert.rejects(downloadEmbeddings())
    const manifestHits = seen.filter(s => s.url.endsWith('/manifest.json'))
    assert.strictEqual(manifestHits.length, 1, 'must call manifest endpoint once')
    assert.ok(manifestHits[0].url.startsWith('https://'), 'manifest URL must be absolute')
  })
})
