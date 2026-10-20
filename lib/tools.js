import { z } from 'zod'
import getModel from './getModel.js'
import fuzzyTopN from './fuzzyTopN.js'
import { authorizeProjectPath } from './projectPath.js'
import searchMarkdownDocs from './searchMarkdownDocs.js'

const tools = {
  search_model: {
    title: 'Search for CDS definitions',
    description:
      'Returns CDS model definitions (CSN), including elements, annotations, parameters, file locations and HTTP endpoints. Useful for building queries, OData URLs, or understanding model structure.',
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
    handler: async (
      { projectPath, name, kind, topN, namesOnly },
      { resolveProjectPath = path => authorizeProjectPath(path, [process.cwd()]) } = {}
    ) => {
      const access = await resolveProjectPath(projectPath)
      const model = await getModel(access.projectPath, access.workspaceRoots)
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
    description: [
      "Search the official SAP CAP (Cloud Application Programming Model) documentation (capire) — covering CDS (CDL, CQL, CSN), the Node.js runtime (`@sap/cds`), the Java runtime (`com.sap.cds`), guides, tools, plugins, deployment, security, databases, protocols, integration, messaging, multitenancy and native AI integration.",
      "Prefer this tool over manual research to learn about CAP syntax, APIs, annotations, configuration, guides, and supported features.",
      "The tool returns up to `maxResults` documentation chunks. It ranks the chunks by semantic similarity."
    ].join('\n'),
    inputSchema: {
      query: z
        .string()
        .describe(
          [
            'Natural-language question or keyword phrase scoped to a single concept.',
            'Do NOT add "CAP", "SAP" or "capire" to the query.',
            'Include "Node.js" or "Java" in the query to select a runtime.'
          ].join('\n')
        ),
      maxResults: z.number().default(5).describe('Maximum number of chunks to return.')
    },
    handler: async ({ query, maxResults }) => {
      return await searchMarkdownDocs(query, maxResults)
    }
  }
}

export default tools
