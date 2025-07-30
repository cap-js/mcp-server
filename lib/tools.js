// Provides tools as object for them to be tested programmatically

import cds from '@sap/cds'
import { z } from 'zod'
import setModel from './setModel.js'
import fuzzyTopN from './fuzzyTopN.js'

const tools = {
  search_cds_definitions: {
    title: 'Search for CDS definitions',
    description:
      'Get model information, returns CSN definitions, containing elements, parameters, file locations, URL endpoints, etc., helpful when constructing queries, OData URLs or when modifying CDS models.',
    inputSchema: {
      projectPath: z.string().describe('Root path of the project'),
      name: z
        .string()
        .optional()
        .describe('Name of the definition (fuzzy search (Levenshtein distance), no regex or special characters)'),
      kind: z.string().optional().describe('Filter for kind of the definition (service, entity, action, ...)'),
      topN: z.number().default(1).describe('Number of results'),
      namesOnly: z
        .boolean()
        .optional()
        .describe(
          'If true, only return the NAMES of the definitions, helpful to get an initial overview.'
        )
    },
    handler: async ({ projectPath, name, kind, topN, namesOnly }) => {
      await setModel(projectPath)
      const defNames = kind
        ? Object.entries(cds.model.definitions)
            // eslint-disable-next-line no-unused-vars
            .filter(([_k, v]) => v.kind === kind)
            .map(([k]) => k)
        : Object.keys(cds.model.definitions)
      const scores = name ? fuzzyTopN(name, defNames, topN) : fuzzyTopN('', defNames, topN)
      if (namesOnly) {
        return scores.map(s => s.item)
      }
      return scores.map(s => cds.model.definitions[s.item])
    }
  }
}

export default tools
