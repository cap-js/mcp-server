import { z } from 'zod'
import getModel from './getModel.js'
import searchMarkdownDocs from './searchMarkdownDocs.js'
import { searchEmbeddings } from './embeddings.js'

const tools = {
  search_model: {
    title: 'Search for CDS definitions',
    description:
      'Returns CDS model definitions (CSN), including elements, annotations, parameters, file locations and HTTP endpoints. Useful for building queries, OData URLs, or modifying models.',
    inputSchema: {
      projectPath: z.string().describe('Root path of the project'),
      name: z.string().optional().describe('Definition name (fuzzy search; no regex or special characters)'),
      kind: z.string().optional().describe('Definition kind to filter by (e.g., service, entity, action)'),
      topN: z.number().default(1).describe('Maximum number of results'),
      namesOnly: z.boolean().default(false).describe('If true, only return definition names (for overview)')
    },
    handler: async ({ projectPath, name, kind, topN, namesOnly }) => {
      const model = await getModel(projectPath)
      const defs = kind
        ? Object.entries(model.definitions)
            // eslint-disable-next-line no-unused-vars
            .filter(([_k, v]) => v.kind === kind)
            .map(([_k, v]) => v)
        : Object.values(model.definitions)
      const results = (await searchEmbeddings(name, defs)).slice(0, topN)
      if (namesOnly) return results.map(r => r.name)
      return results
    }
  },
  search_docs: {
    title: 'Search in CAP Documentation',
    description:
      "Searches code snippets of CAP documentation for the given query. You MUST use this tool if you're unsure about CAP APIs for CDS, Node.js or Java.",
    inputSchema: {
      query: z.string().describe('Search string'),
      maxResults: z.number().default(10).describe('Maximum number of results')
    },
    handler: async ({ query, maxResults }) => {
      return await searchMarkdownDocs(query, maxResults)
    }
  }
}

export default tools
