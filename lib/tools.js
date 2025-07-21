// Provides tools as object for them to be tested programmatically

import cds from '@sap/cds'
import { z } from 'zod'
import { fuzzyTopN } from './utils.js'

const PROJECT_PATH = {
  projectPath: z.string().describe('Root path of the project')
}

// Loads and compiles the CDS model, returns the compiled model or throws on error
async function loadModel(path) {
  cds.root = path
  const loaded = await cds.load('*', { docs: true, locations: true })
  if (!loaded || (Array.isArray(loaded) && loaded.length === 0)) {
    throw new Error(`Failed to load CDS model from path: ${path}`)
  }
  const compiled = cds.compile.for.nodejs(loaded)
  if (!compiled || !compiled.definitions || Object.keys(compiled.definitions).length === 0) {
    throw new Error(`Compiled CDS model is invalid or empty for path: ${path}`)
  }
  const serviceInfo = cds.compile.to.serviceinfo(compiled)

  // merge with definitions
  for (const info of serviceInfo) {
    const def = compiled.definitions[info.name]
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
      exposed.push(each)
    }
    return exposed
  }

  // construct endpoint for each entity and add it to its definition
  compiled.services
    .flatMap(srv => srv.endpoints.map(endpoint => ({ srv, endpoint })))
    .map(({ srv, endpoint }) => {
      const entities = _entities_in(srv)
      for (const e of entities) {
        const path = endpoint.path + e.replace(/\./g, '_')
        const def = compiled.definitions[srv.name + '.' + e]
        def.endpoints ??= []
        def.endpoints.push({ kind: endpoint.kind, path })
        // Add fully qualified entity names to each service as 'exposedEntities'
        for (const service of compiled.services) {
          service.exposedEntities = _entities_in(service).map(shortName => service.name + '.' + shortName)
        }
      }
    })
  return compiled
}

// Ensures only one CDS model compilation is ever in-flight.
// The moment setModel is called, cds.model is set to a promise.
// All consumers must await cds.model if it's defined.
async function setModel(path) {
  if (cds.model) {
    // If cds.model is a promise, await it; if it's resolved, return it
    if (typeof cds.model.then === 'function') await cds.model
    return
  }
  // Assign a promise immediately to cds.model to prevent duplicate compilations
  cds.model = (async () => {
    const compiled = await loadModel(path)
    cds.model = compiled
    return compiled
  })()
  await cds.model
}

// Refreshes the CDS model, only replaces cds.model if compilation succeeds
async function refreshModel(path) {
  try {
    const compiled = await loadModel(path)
    cds.model = compiled
    return compiled
  } catch (err) {
    // If anything goes wrong, cds.model remains untouched
  }
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
