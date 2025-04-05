#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import cds from '@sap/cds'

const model = cds.linked(await cds.load(import.meta.dirname+'/samples/bookstore.csn.json'))
// console.error('Model:', model)
const defs = model.definitions ?? {}

// Create server instance
const server = new McpServer({
  name: 'cds-mdc',
  version: '0.1.0',
  capabilities: {
    resources: {},
    roots: {},
  },
})

const resourceInfo = [
  { name: 'CDS Entities',    uri: 'cds://entities/', kind: 'entity' },
  { name: 'CDS Services',    uri: 'cds://services/', kind: 'service' },
  { name: 'CDS Types',       uri: 'cds://types/',    kind: 'type' },
  { name: 'CDS Aspects',     uri: 'cds://aspects/',  kind: 'aspect' },
  { name: 'CDS Definitions', uri: 'cds://definitions/' },
]
resourceInfo.forEach(({ name, uri, kind }) => {
  server.resource(name, uri, () => {
    const contents = Object.values(defs)
      .filter(d => !kind || d.kind === kind)
      .map(d => toResource(d, uri))
    return { contents }
  })
})


/**
 *
 * @param {cds.csn.Definition} def
 * @param {string} uriScheme
 * @returns {import('@modelcontextprotocol/sdk/types.js').TextResourceContents}
 */
function toResource(def, uriScheme) {
  return {
    uri: uriScheme + def.name,
    name: def.name,
    description: def.doc ?? '',
    text: JSON.stringify(def),
    mimeType: 'application/json',
  }
}

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('CDS MCP Server running on stdio')
}

main().catch((error) => {
  console.error('Fatal error in main():', error)
  process.exit(1)
})