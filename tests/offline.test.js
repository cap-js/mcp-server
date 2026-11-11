import assert from 'node:assert/strict'
import { test, describe, before, afterEach, after, mock } from 'node:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getActiveModel } from '../lib/calculateEmbeddings.js'
import { seedCliTestBundle, runCliCommand } from './helpers/test-bundle.js'

const noFetchEnv = {
  ...process.env,
  NODE_OPTIONS:
    '--import "data:text/javascript,globalThis.fetch = () => { throw new Error(\'fetch disabled in offline mode\') }"'
}

describe('offline mode', () => {
  let ctx
  before(async () => {
    ctx = await seedCliTestBundle()
  })
  after(() => ctx.cleanup())

  test('--offline search_docs works without downloading', async () => {
    const result = await runCliCommand(['--offline', 'search_docs', 'select statement'], {
      env: noFetchEnv
    })
    assert.equal(result.code, 0, result.stderr)
    assert(result.stdout.length > 0)
    assert(result.stdout.includes('---'))
  })

  test('--offline is incompatible with --download', async () => {
    const result = await runCliCommand(['--offline', '--download'])
    assert.equal(result.code, 1, result.stderr)
    assert(result.stderr.includes('must be the only argument'))
  })

  test('CDS_MCP_OFFLINE=true search_docs works without downloading', async () => {
    const result = await runCliCommand(['search_docs', 'select statement'], {
      env: { ...noFetchEnv, CDS_MCP_OFFLINE: 'true' }
    })
    assert.equal(result.code, 0, result.stderr)
    assert(result.stdout.length > 0)
    assert(result.stdout.includes('---'))
  })

  describe('directory override', () => {
    for (const args of [
      ['--offline', 'search_docs', 'select statement'],
      ['search_docs', 'select statement']
    ]) {
      test(`selects an external bundle with ${args.includes('--offline') ? '--offline' : 'CDS_MCP_OFFLINE=true'}`, async (t) => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'cds-mcp-offline-dir-'))
        t.after(() => fs.rm(dir, { recursive: true, force: true }))
        const meta = JSON.parse(await fs.readFile(join(ctx.versionDir, 'code-chunks.json'), 'utf8'))
        meta.model = getActiveModel()
        meta.chunks = meta.chunks.map((chunk) => `External generated bundle: ${chunk}`)
        await fs.writeFile(join(dir, 'code-chunks.json'), JSON.stringify(meta))
        await fs.copyFile(join(ctx.versionDir, 'code-chunks.bin'), join(dir, 'code-chunks.bin'))

        const result = await runCliCommand(args, {
          env: {
            ...noFetchEnv,
            CDS_MCP_OFFLINE: args.includes('--offline') ? 'false' : 'true',
            CDS_MCP_OFFLINE_DIR: '.',
            CDS_MCP_MODEL: 'unavailable/active-model'
          },
          cwd: dir
        })

        assert.equal(result.code, 0, result.stderr)
        assert(result.stdout.includes('External generated bundle:'), result.stdout)
        assert(!result.stderr.includes('Using:'), 'Must not use cache discovery')
      })
    }

    test('rejects a missing bundle without falling back to the cache', async (t) => {
      const dir = await fs.mkdtemp(join(tmpdir(), 'cds-mcp-offline-missing-'))
      t.after(() => fs.rm(dir, { recursive: true, force: true }))
      const result = await runCliCommand(['--offline', 'search_docs', 'select statement'], {
        env: { ...noFetchEnv, CDS_MCP_OFFLINE_DIR: dir }
      })
      assert.equal(result.code, 1, result.stderr)
      assert(result.stderr.includes('ENOENT'), result.stderr)
      assert(result.stderr.includes(join(dir, 'code-chunks.json')), result.stderr)
    })

    test('rejects an empty directory setting', async () => {
      const result = await runCliCommand(['--offline', 'search_docs', 'select statement'], {
        env: { ...noFetchEnv, CDS_MCP_OFFLINE_DIR: '   ' }
      })
      assert.equal(result.code, 1, result.stderr)
      assert(result.stderr.includes('CDS_MCP_OFFLINE_DIR must not be empty'), result.stderr)
    })

    test('preserves corrupted generated files without downloading', async (t) => {
      const dir = await fs.mkdtemp(join(tmpdir(), 'cds-mcp-offline-corrupt-'))
      t.after(() => fs.rm(dir, { recursive: true, force: true }))
      const json = JSON.stringify({ dim: 1, count: 1, chunks: ['Generated content.'] })
      const bin = Buffer.from([0])
      await fs.writeFile(join(dir, 'code-chunks.json'), json)
      await fs.writeFile(join(dir, 'code-chunks.bin'), bin)
      const result = await runCliCommand(['search_docs', 'generated content'], {
        env: { ...noFetchEnv, CDS_MCP_OFFLINE: 'true', CDS_MCP_OFFLINE_DIR: dir }
      })
      assert.equal(result.code, 1, result.stderr)
      assert(result.stderr.includes('Corrupted files'), result.stderr)
      assert(!result.stderr.includes('fetch disabled'), result.stderr)
      assert.equal(await fs.readFile(join(dir, 'code-chunks.json'), 'utf8'), json)
      assert.deepEqual(await fs.readFile(join(dir, 'code-chunks.bin')), bin)
    })

    test('is ignored outside offline mode', async () => {
      const result = await runCliCommand(['search_docs', 'select statement'], {
        env: {
          ...process.env,
          CDS_MCP_OFFLINE: 'false',
          CDS_MCP_OFFLINE_DIR: '/nonexistent/generated/embeddings',
          CDS_MCP_TEST_BUNDLE_PATH: ctx.bundlePath,
          NODE_OPTIONS: `--import "${ctx.mockScriptUrl}"`
        }
      })
      assert.equal(result.code, 0, result.stderr)
      assert(result.stdout.length > 0)
    })
  })

  describe('lazy directory selection', () => {
    let originalEnv, loadChunks, hybridSearch, fetchMock, moduleMock, offlineSearch
    before(async () => {
      originalEnv = {
        CDS_MCP_OFFLINE: process.env.CDS_MCP_OFFLINE,
        CDS_MCP_OFFLINE_DIR: process.env.CDS_MCP_OFFLINE_DIR,
        CDS_MCP_RERANK_ENABLED: process.env.CDS_MCP_RERANK_ENABLED,
        CDS_MCP_GENERIC_EMBEDDINGS: process.env.CDS_MCP_GENERIC_EMBEDDINGS
      }
      process.env.CDS_MCP_OFFLINE = 'true'
      process.env.CDS_MCP_OFFLINE_DIR = '/initial/generated/output'
      process.env.CDS_MCP_RERANK_ENABLED = 'false'
      process.env.CDS_MCP_GENERIC_EMBEDDINGS = 'true'
      loadChunks = mock.fn(async () => {
        const chunks = [{ content: 'Generated documentation.', embeddings: new Float32Array([1]) }]
        chunks.model = 'fixture/generated-model'
        return chunks
      })
      hybridSearch = mock.fn(async (_query, chunks) => chunks)
      moduleMock = mock.module('../lib/embeddings.js', {
        namedExports: { loadChunks, hybridSearch }
      })
      fetchMock = mock.method(globalThis, 'fetch', () =>
        assert.fail('Must not download in offline mode')
      )
      const offlineModule = await import('../lib/searchMarkdownDocs.js')
      offlineSearch = offlineModule.default
    })
    afterEach(() => {
      loadChunks.mock.resetCalls()
      hybridSearch.mock.resetCalls()
      fetchMock.mock.resetCalls()
      process.env.CDS_MCP_OFFLINE_DIR = '/initial/generated/output'
    })
    after(() => {
      moduleMock.restore()
      fetchMock.mock.restore()
      for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    })
    test('defers loading the bundle until a search is requested', () => {
      assert.equal(loadChunks.mock.callCount(), 0)
      assert.equal(hybridSearch.mock.callCount(), 0)
      assert.equal(fetchMock.mock.callCount(), 0)
    })
    test('uses the current override on each search without downloading', async () => {
      for (const dir of ['/first/generated/output', '/second/generated/output']) {
        process.env.CDS_MCP_OFFLINE_DIR = dir
        const result = await offlineSearch('documentation', 1)
        assert.equal(result, 'Generated documentation.')
        assert.deepEqual(loadChunks.mock.calls.at(-1).arguments, [
          'code-chunks',
          dir,
          { deleteCorrupted: false }
        ])
        assert.equal(hybridSearch.mock.calls.at(-1).arguments[1].model, 'fixture/generated-model')
      }
      assert.equal(loadChunks.mock.callCount(), 2)
      assert.equal(fetchMock.mock.callCount(), 0)
    })
  })
})
