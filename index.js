#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import tools from './lib/tools.js'

const server = new McpServer({
  name: 'mcp-server',
  version: '0.1.0'
})

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

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error('Fatal error in main():', error)
  process.exit(1)
})
