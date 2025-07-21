// Provides tools as object for them to be tested programmatically

import cds from '@sap/cds'
import { z } from 'zod'
import setModel from './setModel.js'
import fuzzyTopN from './fuzzyTopN.js'

const PROJECT_PATH = {
  projectPath: z.string().describe('Root path of the project')
}

const tools = {
  search_cds_definitions: {
    title: 'Search for CDS definitions',
    description:
      'Get details of CDS definitions, returns Core Schema Notation (CSN). Use this if you want to see elements, parameters, file locations, URL paths, etc., helpful when constructing queries or OData URLs or when modifying CDS models.',
    inputSchema: {
      ...PROJECT_PATH,
      name: z.string().optional().describe('Name of the definition (fuzzy search, no regex or special characters)'),
      kind: z.string().optional().describe('Kind of the definition (service, entity, action, ...)'),
      topN: z.number().default(1).describe('Number of results')
    },
    handler: async ({ projectPath, name, kind, topN }) => {
      await setModel(projectPath)
      const defNames = kind
        ? Object.entries(cds.model.definitions)
            // eslint-disable-next-line no-unused-vars
            .filter(([_k, v]) => v.kind === kind)
            .map(([k]) => k)
        : Object.keys(cds.model.definitions)
      const scores = name ? fuzzyTopN(name, defNames, topN) : fuzzyTopN('', defNames, topN)
      return scores.map(s => Object.assign({ name: s.item }, cds.model.definitions[s.item]))
    }
  },
  list_all_cds_definition_names: {
    title: 'List all CDS definitions names',
    description:
      'Get an overview of available CDS definitions, for details use `search_cds_definitions`. Helpful for initial exploration, e.g. to get all service names.',
    inputSchema: {
      ...PROJECT_PATH,
      kind: z.string().optional().describe('Kind of the definition (service, entity, action, ...)')
    },
    handler: async ({ projectPath, kind }) => {
      await setModel(projectPath)
      const defNames = kind
        ? Object.entries(cds.model.definitions)
            // eslint-disable-next-line no-unused-vars
            .filter(([_k, v]) => v.kind === kind)
            .map(([k]) => k)
        : Object.keys(cds.model.definitions)
      return defNames
    }
  }
}

export default tools
