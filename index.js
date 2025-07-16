#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { fuzzyTopN } from './lib/utils.js'

const PROJECT_PATH = { projectPath: z.string().describe('Root path of the project') }

import cds from '@sap/cds'

const server = new McpServer({
  name: 'cds-mcp',
  version: '0.1.0',
  capabilities: {
    resources: {},
    roots: {}
  }
})

async function setModel(path) {
  if (cds.model) return
  cds.root = path
  try {
    cds.model = await cds.load('*', { docs: true, locations: true })
    cds.model = cds.compile.for.nodejs(cds.model)
    const serviceInfo = cds.compile.to.serviceinfo(cds.model)
    // merge with definitions
    for (const info of serviceInfo) {
      const def = cds.model.definitions[info.name]
      Object.assign(def, info)
    }
    // TODO: Add endpoint for each entity
  } catch (err) {
    console.error(err)
  }
}

server.tool(
  'find_cds_definition',
  {
    ...PROJECT_PATH,
    name: z.string().describe('Name of the definition (fuzzy search)'),
    n: z.number().default(1).describe('Number of results')
  },
  async ({ projectPath, name, n }) => {
    await setModel(projectPath)
    const names = Object.keys(cds.model.definitions)
    const scores = fuzzyTopN(name, names, n)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(scores.map(s => Object.assign({ name: s.item }, cds.model.definitions[s.item])))
        }
      ]
    }
  }
)

server.tool(
  'list_cds_definition_names',
  { ...PROJECT_PATH, kind: z.string().optional().describe('Kind of the definition (service, entity, action, ...)') },
  async ({ projectPath, kind }) => {
    await setModel(projectPath)
    const definitions = kind
      ? Object.entries(cds.model.definitions)
          .filter(([_k, v]) => v.kind === kind)
          .map(([k]) => k)
      : Object.keys(cds.model.definitions)
    return {
      content: [{ type: 'text', text: JSON.stringify(definitions) }]
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(error => {
  console.error('Fatal error in main():', error)
  process.exit(1)
})
