// Provides tools as object for them to be tested programmatically

import cds from '@sap/cds'
import { z } from 'zod'
import { fuzzyTopN } from './utils.js'

const PROJECT_PATH = { projectPath: z.string().describe('Root path of the project') }

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

    const _entities_in = service => {
      const exposed = [],
        { entities } = service
      for (let each in entities) {
        const e = entities[each]
        if (e['@cds.autoexposed'] && !e['@cds.autoexpose']) continue
        if (/DraftAdministrativeData$/.test(e.name)) continue
        if (/[._]texts$/.test(e.name)) continue
        if (cds.env.effective.odata.containment && service.definition._containedEntities.has(e.name)) continue
        exposed.push(each.replace(/\./g, '_'))
      }
      return exposed
    }

    // construct endpoint for each entity and add it to its definition
    cds.model.services
      .flatMap(srv => srv.endpoints.map(endpoint => ({ srv, endpoint })))
      .map(({ srv, endpoint }) => {
        const entities = _entities_in(srv)
        for (const e of entities) {
          const path = endpoint.path + e.replace(/\./g, '_')
          const def = cds.model.definitions[srv.name + '.' + e]
          def.endpoints ??= []
          def.endpoints.push(path)
        }
      })
  } catch (err) {
    console.error(err)
  }
}

const tools = {
  search_cds_definitions: {
    title: 'Search for CDS definitions',
    description:
      'Get details of CDS definitions, returns Core Schema Notation (CSN). Use this if you want to see elements, parameters, file locations, URL paths, etc., helpful when constructing queries or OData URLs or modifying CDS models.',
    inputSchema: {
      ...PROJECT_PATH,
      name: z.string().optional().describe('Name of the definition (fuzzy search, no regex)'),
      kind: z.string().optional().describe('Kind of the definition (service, entity, action, ...)'),
      n: z.number().default(1).describe('Number of results')
    },
    handler: async ({ projectPath, name, kind, n }) => {
      await setModel(projectPath)
      const defNames = kind
        ? Object.entries(cds.model.definitions)
            .filter(([_k, v]) => v.kind === kind)
            .map(([k]) => k)
        : Object.keys(cds.model.definitions)
      const scores = name ? fuzzyTopN(name, defNames, n) : fuzzyTopN('', defNames, n)
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
            .filter(([_k, v]) => v.kind === kind)
            .map(([k]) => k)
        : Object.keys(cds.model.definitions)
      return defNames
    }
  }
}

export default tools
