// Node.js test runner (test) for lib/tools.js
import tools from '../lib/tools.js'
import assert from 'node:assert'
import { test } from 'node:test'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Point to the sample project directory
const sampleProjectPath = join(dirname(fileURLToPath(import.meta.url)), 'sample')

test.describe('tools', () => {
  test('search_cds_definitions: should find services', async () => {
    const result = await tools.search_cds_definitions.handler({
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

  test('search_cds_definitions: endpoints', async () => {
    // Service endpoints
    const result = await tools.search_cds_definitions.handler({
      projectPath: sampleProjectPath,
      kind: 'service',
      topN: 3
    })
    assert(Array.isArray(result[0].endpoints), 'Should contain endpoints')
    assert.equal(result[0].endpoints[0].kind, 'odata', 'Should contain odata endpoint kind')
    assert.equal(result[0].endpoints[0].path, 'odata/v4/admin/', 'Should contain endpoint path')

    // Entity endpoints
    const books = await tools.search_cds_definitions.handler({
      projectPath: sampleProjectPath,
      query: 'Books',
      kind: 'entity',
      topN: 2
    })
    assert(Array.isArray(books[0].endpoints), 'Should contain endpoints')
    assert.equal(books[0].endpoints[0].kind, 'odata', 'Should contain odata endpoint kind')
    assert.equal(books[0].endpoints[0].path, 'odata/v4/admin/Books', 'Should contain endpoint path')
  })

  test('search_cds_definitions: fuzzy search for Books entity', async () => {
    const books = await tools.search_cds_definitions.handler({
      projectPath: sampleProjectPath,
      query: 'Books',
      kind: 'entity',
      topN: 2
    })
    assert(Array.isArray(books), 'Result should be an array')
    assert(books.length > 0, 'Should find at least one entity')
    assert(books[0].name, 'AdminService.Books', 'Should find AdminService.Books entity')

    // Check that keys are present and correct
    assert(books[0].elements.ID, 'Books entity should have key ID')
    assert(books[0].elements.ID.key === true, 'ID should be marked as key')
  })

  test('search_cds_definitions: draft fields for Books entity', async () => {
    const books = await tools.search_cds_definitions.handler({
      projectPath: sampleProjectPath,
      query: 'Books',
      kind: 'entity',
      topN: 2
    })
    assert(Array.isArray(books), 'Result should be an array')
    assert(books.length > 0, 'Should find at least one entity')
    // Check draft fields
    assert(books[0].elements.IsActiveEntity, 'Draft-enabled entity should have IsActiveEntity')
    assert(books[0].elements.IsActiveEntity.key === true, 'IsActiveEntity should be marked as key')
    assert(books[0].elements.HasActiveEntity, 'Draft-enabled entity should have HasActiveEntity')
    assert(books[0].elements.HasDraftEntity, 'Draft-enabled entity should have HasDraftEntity')
  })

  test('search_cds_definitions: should list all entities (namesOnly)', async () => {
    const entities = await tools.search_cds_definitions.handler({
      projectPath: sampleProjectPath,
      kind: 'entity',
      topN: 100,
      namesOnly: true
    })
    assert(Array.isArray(entities), 'Entities should be an array')
    assert(entities.length > 0, 'Should find at least one entity')
    assert(typeof entities[0] === 'string', 'Should return only names')
  })

  test('search_cds_definitions: should list all services (namesOnly)', async () => {
    const services = await tools.search_cds_definitions.handler({
      projectPath: sampleProjectPath,
      kind: 'service',
      topN: 100,
      namesOnly: true
    })
    assert(Array.isArray(services), 'Services should be an array')
    assert(services.length > 0, 'Should find at least one service')
    assert(typeof services[0] === 'string', 'Should return only names')
  })

  test('search_cap_docs: should find docs and code blocks', async () => {
    // Normal search
    const results = await tools.search_cap_docs.handler({
      query: 'init',
      maxResults: 3,
      codeOnly: false
    })
    assert(Array.isArray(results), 'Results should be an array')
    assert(results.length > 0, 'Should return at least one result')
    assert(
      results.some(r => r.toLowerCase().includes('cds init')),
      'Should contain the words cds init'
    )

    // Code block search
    const codeResults = await tools.search_cap_docs.handler({
      query: 'init',
      maxResults: 5,
      codeOnly: true
    })
    assert(Array.isArray(codeResults), 'Code results should be an array')
    assert(codeResults.length > 0, 'Should return at least one code block result')
    assert(
      codeResults.every(r => r.includes('```')),
      'All results should be code blocks'
    )
  })
})

test('search_cap_docs: event mesh should mention enterprise-messaging', async () => {
  const meshResults = await tools.search_cap_docs.handler({
    query: 'event mesh',
    maxResults: 10,
    codeOnly: false
  })
  assert(Array.isArray(meshResults), 'Results should be an array')
  assert(meshResults.length > 0, 'Should return at least one result')
  assert(
    meshResults.some(r => r.toLowerCase().includes('enterprise-messaging')),
    'Should mention enterprise-messaging in the results'
  )
})
