// Integration test for mcp-server server
import assert from 'node:assert'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { unlinkSync, writeFileSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const sampleProjectPath = join(dirname(fileURLToPath(import.meta.url)), 'sample')
const cdsMcpPath = join(dirname(fileURLToPath(import.meta.url)), '../index.js')

// --- Ensure testService.cds is removed after each test
const testServicePathCorrect = join(dirname(fileURLToPath(import.meta.url)), 'sample', 'srv', 'testService.cds')

test.describe('integration', () => {
  test.afterEach(() => {
    try {
      unlinkSync(testServicePathCorrect)
    } catch {
      /* ignore */
    }
  })

  test('spawn mcp-server and call search_model tool', async () => {
    // Step 2: Spawn the MCP server in the sample project directory
    const transport = new StdioClientTransport({
      command: 'node',
      args: [cdsMcpPath],
      cwd: sampleProjectPath,
      env: { ...process.env, CDS_MCP_OFFLINE: 'true' }
    })

    // Step 3: Use the MCP Client API to connect to the server
    const client = new Client({ name: 'integration-test', version: '1.0.0' })
    await client.connect(transport)

    // Step 4: Programmatically call a tool and verify output
    const result = await client.callTool({
      name: 'search_model',
      arguments: {
        projectPath: sampleProjectPath,
        kind: 'service',
        topN: 1
      }
    })

    assert(Array.isArray(result.content), 'Tool result should be an array')
    assert(result.content.length > 0, 'Should return at least one result')
    const serviceResults = JSON.parse(result.content[0].text)
    assert.equal(serviceResults[0].name, 'AdminService', 'Should return the AdminService')
    // Step 5: Clean up
    await transport.close()
  })

  test('search_model follows multiple roots and root changes advertised by the MCP client', async t => {
    const secondRoot = await mkdtemp(join(tmpdir(), 'cds-mcp-second-root-'))
    t.after(() => rm(secondRoot, { recursive: true, force: true }))
    await mkdir(join(secondRoot, 'srv'))
    await writeFile(
      join(secondRoot, 'srv', 'service.cds'),
      'service SecondService { entity Items { key ID: Integer; } }'
    )

    const transport = new StdioClientTransport({
      command: 'node',
      args: [cdsMcpPath],
      cwd: sampleProjectPath,
      env: { ...process.env, CDS_MCP_OFFLINE: 'true' }
    })
    const client = new Client(
      { name: 'integration-test-roots', version: '1.0.0' },
      { capabilities: { roots: { listChanged: true } } }
    )
    let roots = [sampleProjectPath, secondRoot]
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: roots.map(root => ({ uri: pathToFileURL(root).href }))
    }))
    await client.connect(transport)

    const firstProject = await client.callTool({
      name: 'search_model',
      arguments: { projectPath: sampleProjectPath, kind: 'service', topN: 1 }
    })
    assert.equal(JSON.parse(firstProject.content[0].text)[0].name, 'AdminService')

    const secondProject = await client.callTool({
      name: 'search_model',
      arguments: { projectPath: secondRoot, kind: 'service', topN: 1 }
    })
    assert.equal(JSON.parse(secondProject.content[0].text)[0].name, 'SecondService')

    roots = [secondRoot]
    await client.sendRootsListChanged()
    const rejected = await client.callTool({
      name: 'search_model',
      arguments: { projectPath: sampleProjectPath, kind: 'service', topN: 1 }
    })
    assert.match(rejected.content[0].text, /outside the configured workspace roots/)

    await transport.close()
  })

  test('model adapts to CDS file changes on the next request', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [cdsMcpPath],
      cwd: sampleProjectPath,
      env: { ...process.env, CDS_MCP_OFFLINE: 'true' }
    })

    const client = new Client({
      name: 'integration-test-model-change',
      version: '1.0.0'
    })
    await client.connect(transport)

    // Step 2: Ensure TestService/TestEntity are NOT found
    const serviceResultBefore = await client.callTool({
      name: 'search_model',
      arguments: {
        projectPath: sampleProjectPath,
        kind: 'service',
        topN: 20
      }
    })
    const servicesBefore = JSON.parse(serviceResultBefore.content[0].text)
    assert(!servicesBefore.some(s => s.name === 'TestService'), 'TestService should NOT be found before creation')

    const entityResultBefore = await client.callTool({
      name: 'search_model',
      arguments: {
        projectPath: sampleProjectPath,
        kind: 'entity',
        topN: 20
      }
    })
    const entitiesBefore = JSON.parse(entityResultBefore.content[0].text)
    assert(!entitiesBefore.some(e => e.name === 'TestEntity'), 'TestEntity should NOT be found before creation')

    // Step 3: Create testService.cds with a test entity/service
    const testServiceDef = `service TestService { entity TestEntity { key ID: Integer; name: String; } }`
    writeFileSync(testServicePathCorrect, testServiceDef)

    let foundService = false
    let foundEntity = false
    // Check for TestService
    const serviceResult = await client.callTool({
      name: 'search_model',
      arguments: {
        projectPath: sampleProjectPath,
        kind: 'service',
        topN: 20
      }
    })
    const services = JSON.parse(serviceResult.content[0].text)
    if (services.some(s => s.name === 'TestService')) {
      foundService = true
    }
    // Check for TestEntity
    const entityResult = await client.callTool({
      name: 'search_model',
      arguments: {
        projectPath: sampleProjectPath,
        kind: 'entity',
        topN: 30
      }
    })
    const entities = JSON.parse(entityResult.content[0].text)
    if (entities.some(e => e.name === 'TestService.TestEntity')) {
      foundEntity = true
    }
    assert(foundService, 'Model should adapt and expose TestService')
    assert(foundEntity, 'Model should adapt and expose TestEntity')

    // Step 5: Clean up
    await transport.close()
  })
})
