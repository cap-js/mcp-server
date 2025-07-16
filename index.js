#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import tools from './lib/tools.js'

const server = new McpServer({
  name: 'cds-mcp',
  version: '0.1.0',
  capabilities: {
    resources: {},
    roots: {}
  }
})

for (const t in tools) {
  const tool = tools[t]
  const _text =
    fn =>
    async (...args) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(await fn(...args))
        }
      ]
    })
  server.registerTool(t, tool, _text(tool.handler))
}

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(error => {
  console.error('Fatal error in main():', error)
  process.exit(1)
})
