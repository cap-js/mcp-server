import assert from 'node:assert'
import { describe, test, after, mock } from 'node:test'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { setEmbeddingsDir } from '../lib/calculateEmbeddings.js'
import { buildTestBundle } from './helpers/test-bundle.js'

const sampleProjectPath = join(dirname(fileURLToPath(import.meta.url)), 'sample')

const tmpDir = await fsp.mkdtemp(join(os.tmpdir(), 'tools-'))
setEmbeddingsDir(tmpDir)

// Serve the real embeddings bundle for this file's in-process fetch calls.
let _frame = null
mock.method(globalThis, 'fetch', async () => {
  if (!_frame) _frame = buildTestBundle()
  const f = await _frame
  const version = '__test_bundle__'
  return new Response(f, {
    status: 200,
    headers: { etag: `W/"${version}"`, 'x-embeddings-version': version, 'content-type': 'application/octet-stream' }
  })
})

const tools = (await import('../lib/tools.js')).default

after(async () => {
  mock.restoreAll()
  setEmbeddingsDir()
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('tools', () => {
  describe('search_model', () => {
    test('returns AdminService with exposedEntities when querying by kind=service', async () => {
      const result = await tools.search_model.handler({
        projectPath: sampleProjectPath,
        kind: 'service',
        topN: 3
      })
      assert(Array.isArray(result), 'Result should be an array')
      assert(result.length > 0, 'Should find at least one service')
      assert.equal(result[0].name, 'AdminService', 'Should find Adminservice.Books service')
      assert(Array.isArray(result[0].exposedEntities), 'Should contain exposed entities')
      assert.equal(result[0].exposedEntities[0], 'AdminService.Books', 'Should contain exposed entities')
    })

    test('service and entity results include odata endpoint with correct path', async () => {
      // Service endpoints
      const result = await tools.search_model.handler({
        projectPath: sampleProjectPath,
        kind: 'service',
        topN: 3
      })
      assert(Array.isArray(result[0].endpoints), 'Should contain endpoints')
      assert.equal(result[0].endpoints[0].kind, 'odata', 'Should contain odata endpoint kind')
      assert.equal(result[0].endpoints[0].path, 'odata/v4/admin/', 'Should contain endpoint path')

      // Entity endpoints
      const books = await tools.search_model.handler({
        projectPath: sampleProjectPath,
        name: 'Books',
        kind: 'entity',
        topN: 2
      })
      assert(Array.isArray(books[0].endpoints), 'Should contain endpoints')
      assert.equal(books[0].endpoints[0].kind, 'odata', 'Should contain odata endpoint kind')
      assert.equal(books[0].endpoints[0].path, 'odata/v4/admin/Books', 'Should contain endpoint path')
    })

    test('fuzzy search for Books entity returns elements and key', async () => {
      const books = await tools.search_model.handler({
        projectPath: sampleProjectPath,
        name: 'Books',
        kind: 'entity',
        topN: 2
      })
      assert(Array.isArray(books), 'Result should be an array')
      assert(books.length > 0, 'Should find at least one entity')
      assert.equal(books[0].name, 'AdminService.Books', 'Should find AdminService.Books entity')

      assert(books[0].elements.ID, 'Books entity should have key ID')
      assert(books[0].elements.ID.key === true, 'ID should be marked as key')
    })

    test('draft-enabled entity includes IsActiveEntity, HasActiveEntity, HasDraftEntity fields', async () => {
      const books = await tools.search_model.handler({
        projectPath: sampleProjectPath,
        name: 'Books',
        kind: 'entity',
        topN: 2
      })
      assert(Array.isArray(books), 'Result should be an array')
      assert(books.length > 0, 'Should find at least one entity')
      assert(books[0].elements.IsActiveEntity, 'Draft-enabled entity should have IsActiveEntity')
      assert(books[0].elements.IsActiveEntity.key === true, 'IsActiveEntity should be marked as key')
      assert(books[0].elements.HasActiveEntity, 'Draft-enabled entity should have HasActiveEntity')
      assert(books[0].elements.HasDraftEntity, 'Draft-enabled entity should have HasDraftEntity')
    })

    test('lists all entities as name strings when namesOnly=true', async () => {
      const entities = await tools.search_model.handler({
        projectPath: sampleProjectPath,
        kind: 'entity',
        topN: 100,
        namesOnly: true
      })
      assert(Array.isArray(entities), 'Entities should be an array')
      assert(entities.length > 0, 'Should find at least one entity')
      assert(typeof entities[0] === 'string', 'Should return only names')
    })

    test('lists all services as name strings when namesOnly=true', async () => {
      const services = await tools.search_model.handler({
        projectPath: sampleProjectPath,
        kind: 'service',
        topN: 100,
        namesOnly: true
      })
      assert(Array.isArray(services), 'Services should be an array')
      assert(services.length > 0, 'Should find at least one service')
      assert(typeof services[0] === 'string', 'Should return only names')
    })
  })

  describe('search_docs', () => {
    test('result for "create a new cap project" includes "cds init"', async () => {
      const results = await tools.search_docs.handler({
        query: 'how to create a new cap project',
        maxResults: 10
      })
      assert(results.toLowerCase().includes('cds init'), 'Should contain the words cds init')
    })

    test('event mesh query mentions enterprise-messaging', async () => {
      const meshResults = await tools.search_docs.handler({
        query: 'event mesh config',
        maxResults: 10
      })
      assert(
        meshResults.toLowerCase().includes('enterprise-messaging'),
        'Should mention enterprise-messaging in the results'
      )
    })
  })

  test('get_doc_context: returns neighbors distinct from anchor', async () => {
    const seed = await tools.search_docs.handler({ query: 'sqlite production', maxResults: 1 })
    assert(seed && seed.length > 0, 'seed chunk required')

    const ctx = await tools.get_doc_context.handler({ chunk: seed, direction: 'after', count: 2 })
    assert.strictEqual(typeof ctx, 'string')
    assert(ctx.length > 0, 'context should not be empty')
    const parts = ctx.split('\n---\n')
    assert(parts.length <= 2, 'at most 2 chunks for count=2')
    for (const p of parts) assert.notStrictEqual(p, seed)
  })

  test('get_doc_context: default direction is after', async () => {
    const seed = await tools.search_docs.handler({ query: 'entity definition', maxResults: 1 })
    const withDefault = await tools.get_doc_context.handler({ chunk: seed, count: 1 })
    const withExplicit = await tools.get_doc_context.handler({ chunk: seed, direction: 'after', count: 1 })
    assert.strictEqual(withDefault, withExplicit)
  })
})
