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

const models = new Map()
async function getModel(path) {
  if (models.has(path)) return models.get(path)
  cds.root = path
  try {
    const model = cds.linked(await cds.load('*', { docs: true, locations: true }))
    models.set(path, model)
    return model
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
    const model = await getModel(projectPath)
    const names = Object.keys(model.definitions)
    const scores = fuzzyTopN(name, names, n)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(scores.map(s => Object.assign({ name: s.item }, model.definitions[s.item])))
        }
      ]
    }
  }
)

server.tool(
  'list_cds_definition_names',
  { ...PROJECT_PATH, kind: z.string().optional().describe('Kind of the definition (service, entity, action, ...)') },
  async ({ projectPath, kind }) => {
    const model = await getModel(projectPath)
    const definitions = kind
      ? Object.entries(model.definitions)
          .filter(([_k, v]) => v.kind === kind)
          .map(([k]) => k)
      : Object.keys(model.definitions)
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
