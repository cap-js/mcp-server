import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import tools from './tools.js'

export function registerTools(server) {
  for (const t in tools) {
    const tool = tools[t]
    const _text =
      fn =>
      async (...args) => {
        const result = await fn(...args).catch(error => error.message)
        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'object' ? JSON.stringify(result) : result
            }
          ]
        }
      }
    server.registerTool(t, tool, _text(tool.handler))
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
    const result = await tool.handler(params)
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
    name: 'mcp-server',
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
