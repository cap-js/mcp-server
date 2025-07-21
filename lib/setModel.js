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

// Global cache object for CDS file timestamps
const cache = { cdsFiles: new Map() }
let changeWatcher = null

async function cdsFilesChanged(path) {
  if (path.endsWith('/')) path = path.slice(0, -1)
  const files = cds.resolve(path + '/*')
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

  const endTime = Date.now()
  const compileDuration = endTime - startTime

  // Only do it once
  if (!changeWatcher)
    changeWatcher = setInterval(
      async () => {
        const hasChanged = await cdsFilesChanged(path)
        if (hasChanged) await refreshModel(path)
      },
      Math.max(compileDuration * 10, 20000)
    ).unref() // 10 times the initial compile duration seems reasonable, at least 20 seconds
  return compiled
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
