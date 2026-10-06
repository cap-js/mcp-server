import { performance } from 'node:perf_hooks'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { authorizeProjectPath, createMcpProjectPathResolver } from './projectPath.js'
import tools from './tools.js'
import { record } from './telemetry.js'

export function registerTools(server, context = {}) {
  context.resolveProjectPath ??= createMcpProjectPathResolver(server.server)
  for (const t in tools) {
    const tool = tools[t]
    const _text = (fn, toolName) => async (args, extra) => {
      const start = performance.now()
      let success = true
      const result = await fn(args, context).catch(error => {
        success = false
        return error.message
      })
      record({
        timestamp: new Date().toISOString(),
        tool: toolName,
        args,
        ...(process.env.CDS_MCP_MODEL !== undefined && { embedModel: process.env.CDS_MCP_MODEL }),
        ...(process.env.RERANK_ENABLED !== undefined && { rerankEnabled: process.env.RERANK_ENABLED }),
        ...(process.env.CDS_MCP_RERANK_MODEL !== undefined && { rerankModel: process.env.CDS_MCP_RERANK_MODEL }),
        ...(process.env.CDS_MCP_RERANK_DTYPE !== undefined && { rerankDType: process.env.CDS_MCP_RERANK_DTYPE }),
        ...(process.env.CDS_MCP_RERANK_EXTERNAL_DATA !== undefined && { rerankExternalData: process.env.CDS_MCP_RERANK_EXTERNAL_DATA }),
        durationMs: performance.now() - start,
        success,
        sessionId: extra?.sessionId,
        client: server.server.getClientVersion(),
      })
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'object' ? JSON.stringify(result) : result
          }
        ]
      }
    }
    server.registerTool(t, tool, _text(tool.handler, t))
  }
  return server
}

/* eslint-disable no-console */
export async function runTool(toolName, ...args) {
  const tool = tools[toolName]
  if (!tool) {
    console.error(`Tool '${toolName}' not found`)
    console.error(`Available tools: ${Object.keys(tools).join(', ')}`)
    process.exit(1)
  }

  // Parse arguments into an object based on tool schema
  const schema = tool.inputSchema
  const schemaKeys = Object.keys(schema)
  const params = {}

  for (let i = 0; i < args.length; i++) {
    const key = schemaKeys[i]
    if (key) {
      params[key] = args[i]
    }
  }

  try {
    const context = {
      resolveProjectPath: async projectPath => {
        const access = await authorizeProjectPath(projectPath, [projectPath])
        // Direct CLI invocations explicitly trust their project and retain historical support for model imports
        // outside its directory. MCP requests remain restricted to client-advertised workspace roots.
        return { ...access, workspaceRoots: null }
      }
    }
    const result = await tool.handler(params, context)
    console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result)
    return result
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export default async function run(serverInstance = null) {
  // If a server instance is provided, register tools on it
  if (serverInstance) {
    return registerTools(serverInstance)
  }

  // Otherwise, create and start a new server
  const server = new McpServer({
    name: 'cds-mcp',
    version: '0.1.0'
  })

  registerTools(server)

  const transport = new StdioServerTransport()
  await server.connect(transport).catch(error => {
    console.error('Fatal error in main():', error)
    process.exit(1)
  })

  return server
}
