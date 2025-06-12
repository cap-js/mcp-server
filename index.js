#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from "zod";
import { fuzzyTopN } from './utils.js';


import cds from '@sap/cds'

// Create server instance
const server = new McpServer({
  name: 'cds-mcp',
  version: '0.1.0',
  capabilities: {
    resources: {},
    roots: {},
  },
})

const model = await loadModel()

const resourceInfo = [
  { name: 'Entities',    uri: 'cds://entities/', kind: 'entity' },
  { name: 'Services',    uri: 'cds://services/', kind: 'service' },
  { name: 'Types',       uri: 'cds://types/',    kind: 'type' },
  { name: 'Aspects',     uri: 'cds://aspects/',  kind: 'aspect' },
  { name: 'Definitions', uri: 'cds://definitions/' },
]
resourceInfo.forEach(({ name, uri, kind }) => {
  server.resource(name, uri, () => {
    const contents = Object.values(model?.definitions ?? {})
      .filter(d => !kind || d.kind === kind)
      .map(d => toResource(d, uri))
    return { contents }
  })
})

async function loadModel() {
  if (process.argv.length > 2) cds.root = process.argv[2]
  try {
    const model = cds.linked(await cds.load('*', {docs: true}))
    console.error(`Found ${Object.keys(model.definitions).length} definitions in ${cds.root}`)
    return model
  } catch (err) {
    console.error(err)
  }
}

/**
 * @param {cds.csn.Definition} def
 * @param {string} uriBase
 * @returns {import('@modelcontextprotocol/sdk/types.js').TextResourceContents}
 */
function toResource(def, uriBase) {
  return {
    uri: uriBase + def.name,
    name: def.name,
    description: def.doc ?? '',
    text: JSON.stringify(def),
    mimeType: 'application/json',
  }
}

server.tool("search_definitions",
  { name: z.string(), n: z.number().optional().default(1) },
  async ({ name, n }) => {
    const names = Object.keys(model.definitions)
    const scores = fuzzyTopN(name, names, n)
    return {
      content: [{ type: "text", text: JSON.stringify(scores.map(s => Object.assign({ name: s.item }, model.definitions[s.item]))) }]
    }
  }
);

server.tool("list_definitions",
  {},
  async ({}) => {
    const names = Object.keys(model.definitions)
    return {
      content: [{ type: "text", text: JSON.stringify(Object.keys(model.definitions)) }]
    }
  }
);

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('CDS MCP Server running on stdio')
}

main().catch((error) => {
  console.error('Fatal error in main():', error)
  process.exit(1)
})
