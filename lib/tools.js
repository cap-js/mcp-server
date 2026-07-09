import { z } from 'zod'
import getModel from './getModel.js'
import fuzzyTopN from './fuzzyTopN.js'
import searchMarkdownDocs from './searchMarkdownDocs.js'
import searchReleaseDocs from './searchReleaseDocs.js'

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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false
    },
    handler: async ({ projectPath, name, kind, topN, namesOnly }) => {
      const model = await getModel(projectPath)
      const defNames = kind
        ? Object.entries(model.definitions)
            // eslint-disable-next-line no-unused-vars
            .filter(([_k, v]) => v.kind === kind)
            .map(([k]) => k)
        : Object.keys(model.definitions)
      const scores = name ? fuzzyTopN(name, defNames, topN) : fuzzyTopN('', defNames, topN)
      if (namesOnly) return scores.map(s => s.item)
      return scores.map(s => model.definitions[s.item])
    }
  },
  search_docs: {
    title: 'Search in CAP Documentation',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    },
    description:
      "Searches code snippets of CAP documentation for the given query. You MUST use this tool if you're unsure about CAP APIs for CDS, Node.js or Java. Optionally returns only code blocks.",
    inputSchema: {
      query: z.string().describe('Search string'),
      maxResults: z.number().default(10).describe('Maximum number of results')
    },
    handler: async ({ query, maxResults }) => {
      return await searchMarkdownDocs(query, maxResults)
    }
  },
  search_release_notes: {
    title: 'Search CAP Release Notes',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    },
    description:
      'Searches CAP release notes and changelog entries. Use this to find out what changed in a specific version, or whether a feature or behavior was added, removed, or modified.',
    inputSchema: {
      query: z.string().describe('Search string'),
      maxResults: z.number().default(10).describe('Maximum number of results')
    },
    handler: async ({ query, maxResults }) => {
      return await searchReleaseDocs(query, maxResults)
    }
  }
}

export default tools
