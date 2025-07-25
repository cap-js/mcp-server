import cds from '@sap/cds'
import fs from 'fs'

// Ensures only one CDS model compilation is ever in-flight.
// The moment setModel is called, cds.model is set to a promise.
// All consumers must await cds.model if it's defined.
export default async function setModel(path) {
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

// Partially taken over from @sap/cds, to avoid `compile.for.nodejs` and `compile.to.serviceinfo`
// or starting the real application.
// Custom servers (with paths defined in code) are not supported.
// TODO: Check how it works in Java.
const getEndpoints = srv => {
  const _slugified = name =>
    /[^.]+$/
      .exec(name)[0] //> my.very.CatalogService --> CatalogService
      .replace(/Service$/, '') //> CatalogService --> Catalog
      .replace(/_/g, '-') //> foo_bar_baz --> foo-bar-baz
      .replace(/([a-z0-9])([A-Z])/g, (_, c, C) => c + '-' + C) //> ODataFooBarX9 --> OData-Foo-Bar-X9
      .toLowerCase() //> FOO --> foo
  let annos = srv['@protocol']
  if (annos) {
    if (annos === 'none' || annos['='] === 'none') return []
    if (!annos.reduce) annos = [annos]
  } else {
    annos = []
    for (const kind of ['odata', 'rest']) {
      let path = srv['@' + kind] || srv['@protocol.' + kind]
      if (path) annos.push({ kind, path })
    }
  }

  if (!annos.length) annos.push({ kind: 'odata' })

  const endpoints = annos.map(each => {
    let { kind = each['='] || each, path } = each
    if (typeof path !== 'string') path = srv['@path'] || _slugified(srv.name)
    if (path[0] !== '/')
      path =
        { 'odata-v4': '/odata/v4', odata: '/odata/v4', 'odata-v2': '/odata/v2', rest: '/rest', hcql: '/hcql' }[kind] +
        '/' +
        path // prefix with protocol path
    if (!path.endsWith('/')) path = path + '/'
    return { kind, path }
  })

  return endpoints
}

// Global cache object for CDS file timestamps
const cache = { cdsFiles: new Map() }
let changeWatcher = null

async function cdsFilesChanged(path) {
  if (path.endsWith('/')) path = path.slice(0, -1)
  const files = cds.resolve(path + '/*', { cache: {} }) || []
  const currentTimestamps = new Map()
  await Promise.all(
    files.map(file =>
      fs.promises
        .stat(file)
        .then(stat => {
          currentTimestamps.set(file, stat.mtimeMs)
        })
        .catch(() => {
          /* File might have been deleted between resolve and stat */
        })
    )
  )

  const _hasChanged = () => {
    if (currentTimestamps.size !== cache.cdsFiles.size) {
      return true
    }
    // Check for changed timestamps
    for (const f of files) {
      const prev = cache.cdsFiles.get(f)
      const curr = currentTimestamps.get(f)
      if (prev !== curr) {
        return true
      }
    }
  }
  if (_hasChanged()) {
    cache.cdsFiles = currentTimestamps
    return true
  }
  return false
}

// Loads and compiles the CDS model, returns the compiled model or throws on error
async function loadModel(path) {
  cds.root = path
  const startTime = Date.now()
  const resolved = cds.resolve(path + '/*', { cache: {} }) // make sure NOT to use the cache
  const compiled = await cds.load(resolved, { docs: true, locations: true })
  if (!compiled || (Array.isArray(compiled) && compiled.length === 0)) {
    throw new Error(`Failed to load CDS model from path: ${path}`)
  }
  if (!compiled.definitions || Object.keys(compiled.definitions).length === 0) {
    throw new Error(`Compiled CDS model is invalid or empty for path: ${path}`)
  }

  for (const defName in compiled.definitions) {
    // Add name for each definition
    const def = compiled.definitions[defName]
    def.name = defName
    // Add endpoints for each service
    if (compiled.kind === 'service') {
    }
  }

  const _entities_in = (service, compiled) => {
    const exposed = []
    const entities = Object.keys(compiled.definitions).filter(name => name.startsWith(service.name + '.'))
    for (let each of entities) {
      const e = compiled.definitions[each]
      if (e['@cds.autoexposed'] && !e['@cds.autoexpose']) continue
      if (/DraftAdministrativeData$/.test(e.name)) continue
      if (/[._]texts$/.test(e.name)) continue
      // ignore for now
      // if (cds.env.effective.odata.containment && service.definition._containedEntities.has(e.name)) continue
      exposed.push(each)
    }
    return exposed
  }

  // construct endpoint for each entity and add it to its definition
  Object.keys(compiled.definitions)
    .filter(name => compiled.definitions[name].kind === 'service')
    .map(name => {
      const srv = compiled.definitions[name]
      srv.endpoints = getEndpoints(srv)
      return srv
    })
    .flatMap(srv => srv.endpoints.map(endpoint => ({ srv, endpoint })))
    .map(({ srv, endpoint }) => {
      const entities = _entities_in(srv, compiled)
      for (const e of entities) {
        const path = endpoint.path + e.slice(srv.name.length + 1).replace(/\./g, '_')
        const def = compiled.definitions[e]
        def.endpoints ??= []
        def.endpoints.push({ kind: endpoint.kind, path })
      }
    })

  const endTime = Date.now()
  const compileDuration = endTime - startTime

  // Only do it once
  if (!changeWatcher) {
    const intervalMs = process.env.CDS_MCP_REFRESH_MS
      ? parseInt(process.env.CDS_MCP_REFRESH_MS, 10)
      : Math.max(compileDuration * 10, 20000)
    changeWatcher = setInterval(async () => {
      const hasChanged = await cdsFilesChanged(path)
      if (hasChanged) {
        await refreshModel(path)
      }
    }, intervalMs).unref() // Uses CDS_MCP_REFRESH_MS if set, otherwise defaults to 10x compile duration or 20s
  }
  return compiled
}

// Refreshes the CDS model, only replaces cds.model if compilation succeeds
async function refreshModel(path) {
  try {
    const compiled = await loadModel(path)
    cds.model = compiled
    return compiled
  } catch {
    // If anything goes wrong, cds.model remains untouched
  }
}
