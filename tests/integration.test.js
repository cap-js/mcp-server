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

async function runAgent(query, { projectPath = sampleProjectPath } = {}) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [cdsMcpPath],
    cwd: projectPath,
    env: { ...process.env, CDS_MCP_OFFLINE: 'true' }
  })
  const mcpClient = new Client({ name: 'run-agent', version: '1.0.0' })
  await mcpClient.connect(transport)

  const { tools: mcpTools } = await mcpClient.listTools()
  const anthropicTools = mcpTools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }))

  const toolCalls = []
  const origCallTool = mcpClient.callTool.bind(mcpClient)
  mcpClient.callTool = async params => {
    const result = await origCallTool(params)
    toolCalls.push({ tool: params.name, args: params.arguments, result })
    return result
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const anthropic = new Anthropic()
  const messages = [{ role: 'user', content: query }]
  let text = ''

  for (let i = 0; i < 5; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      tools: anthropicTools,
      messages
    })

    for (const block of response.content) {
      if (block.type === 'text') text += block.text
    }

    if (response.stop_reason !== 'tool_use') break

    messages.push({ role: 'assistant', content: response.content })

    const toolResults = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      let content
      try {
        const mcpResult = await mcpClient.callTool({ name: block.name, arguments: block.input })
        content = (mcpResult.content ?? [])
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n')
      } catch (e) {
        content = `Error: ${e.message}`
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content })
    }

    messages.push({ role: 'user', content: toolResults })
  }

  await transport.close()

  const toolWasCalled = (name, predicate) =>
    toolCalls.some(c => c.tool === name && (predicate === undefined || predicate(c.args)))

  return { text, toolCalls, toolWasCalled }
}

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

  test('records which tools were called and supports predicate checks', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [cdsMcpPath],
      cwd: sampleProjectPath,
      env: { ...process.env, CDS_MCP_OFFLINE: 'true' }
    })
    const client = new Client({ name: 'integration-test-tool-recorder', version: '1.0.0' })
    await client.connect(transport)

    const toolCalls = []
    const origCallTool = client.callTool.bind(client)
    client.callTool = async (params) => {
      const result = await origCallTool(params)
      toolCalls.push({ tool: params.name, args: params.arguments, result })
      return result
    }
    const toolWasCalled = (name, predicate) =>
      toolCalls.some(c => c.tool === name && (predicate === undefined || predicate(c.args)))

    // Get a seed chunk via search_docs, then expand context via get_doc_context.
    // The agent may resolve context via get_doc_context or by running a wider search_docs query.
    // Either counts.
    const { content: [{ text: chunk }] } = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'sqlite production', maxResults: 1 }
    })
    await client.callTool({
      name: 'get_doc_context',
      arguments: { chunk, direction: 'after', count: 2 }
    })

    assert(toolWasCalled('search_docs'), 'search_docs must have been called')
    assert(
      toolWasCalled('get_doc_context') || toolWasCalled('search_docs', args => args.maxResults > 1),
      'context expansion must use get_doc_context or a broader search_docs call'
    )
    assert(!toolWasCalled('search_model'), 'search_model should not have been called')

    await transport.close()
  })

  test('server exposes exactly the expected MCP tools', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [cdsMcpPath],
      cwd: sampleProjectPath,
      env: { ...process.env, CDS_MCP_OFFLINE: 'true' }
    })
    const client = new Client({ name: 'integration-test-list-tools', version: '1.0.0' })
    await client.connect(transport)

    const { tools } = await client.listTools()
    const toolNames = tools.map(t => t.name)

    assert(toolNames.includes('search_model'), 'server must expose search_model')
    assert(toolNames.includes('search_docs'), 'server must expose search_docs')
    assert(toolNames.includes('get_doc_context'), 'server must expose get_doc_context')
    assert.equal(toolNames.length, 3, 'server must expose exactly 3 tools')

    await transport.close()
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

  test('does not return out-of-root compiler diagnostics to MCP clients', async t => {
    const workspace = await mkdtemp(join(tmpdir(), 'cds-mcp-diagnostics-'))
    t.after(() => rm(workspace, { recursive: true, force: true }))
    const project = join(workspace, 'project')
    const privateDirectory = join(workspace, 'private')
    const privateModel = join(privateDirectory, 'model.cds')
    await Promise.all([mkdir(join(project, 'srv'), { recursive: true }), mkdir(privateDirectory)])
    await writeFile(privateModel, 'entity SECRET_CUSTOMER_TABLE { key ID Integer; }')
    await writeFile(
      join(project, 'srv', 'service.cds'),
      "using { SECRET_CUSTOMER_TABLE } from '../../private/model'; service LeakingService { entity Items as projection on SECRET_CUSTOMER_TABLE; }"
    )

    const transport = new StdioClientTransport({
      command: 'node',
      args: [cdsMcpPath],
      cwd: project,
      env: { ...process.env, CDS_MCP_OFFLINE: 'true' }
    })
    const client = new Client({ name: 'integration-test-diagnostics', version: '1.0.0' })
    await client.connect(transport)
    t.after(() => transport.close())

    const result = await client.callTool({
      name: 'search_model',
      arguments: { projectPath: project, kind: 'service', topN: 1 }
    })

    assert.equal(result.content[0].text, 'Failed to compile CDS model')
    assert(!result.content[0].text.includes(privateModel))
    assert(!result.content[0].text.includes('SECRET_CUSTOMER_TABLE'))
  })

  test('agent autonomously calls search_docs or search_model to answer a CDS question', { timeout: 60000 }, async t => {
    if (!process.env.ANTHROPIC_AUTH_TOKEN) {
      t.skip('ANTHROPIC_AUTH_TOKEN not set')
      return
    }

    const query =
      'Walk me through the CDS documentation section on draft handling step by step'
    const { text, toolWasCalled } = await runAgent(query)

    assert(
      toolWasCalled('search_docs') || toolWasCalled('search_model'),
      'agent must call search_docs or search_model'
    )
    assert(toolWasCalled('get_doc_context'), 'agent must call get_doc_context to expand surrounding documentation')
    assert(text.length > 0, 'agent must produce a text response')
  })
})
