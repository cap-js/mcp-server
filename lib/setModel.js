import cds from '@sap/cds'
import fs from 'fs'

// Ensures only one CDS model compilation is ever in-flight.
// The moment setModel is called, cds.model is set to a promise.
export default async function setModel(path) {
  if (cds.model) {
    // If cds.model is a promise, await it; if it's resolved, return it
    if (typeof cds.model.then === 'function') await cds.model
    return
  }
  // Assign a promise immediately to cds.model to prevent duplicate compilations
  cds.model = (async () => {
    const compiled = await compileModel(path)
    cds.model = compiled
    return compiled
  })()

  await cds.model
}

// Loads and compiles the CDS model, returns the compiled model or throws on error
async function compileModel(path) {
  cds.root = path
  const startTime = Date.now()
  const resolved = cds.resolve(path + '/*', { cache: {} }) // make sure NOT to use the cache
  let compiled = await cds.load(resolved, { docs: true, locations: true })
  if (!compiled || (Array.isArray(compiled) && compiled.length === 0)) {
    throw new Error(`Failed to load CDS model from path: ${path}`)
  }
  if (!compiled.definitions || Object.keys(compiled.definitions).length === 0) {
    throw new Error(`Compiled CDS model is invalid or empty for path: ${path}`)
  }
  compiled = cds.compile.for.nodejs(compiled) // to include drafts, show effective types
  const serviceInfo = cds.compile.to.serviceinfo(compiled)

  // merge with definitions
  for (const info of serviceInfo) {
    const def = compiled.definitions[info.name]
    Object.assign(def, info)
  }

  for (const name in compiled.definitions) {
    Object.defineProperty(compiled.definitions[name], 'name', { value: name, enumerable: true })
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

  compiled.services.forEach(srv => {
    const entities = _entities_in(srv)
    srv.exposedEntities = entities.map(e => srv.name + '.' + e)
    if (srv.endpoints)
      srv.endpoints.forEach(endpoint => {
        for (const e of entities) {
          const path = endpoint.path + e.replace(/\./g, '_')
          const def = compiled.definitions[srv.name + '.' + e]
          def.endpoints ??= []
          def.endpoints.push({ kind: endpoint.kind, path })
        }
      })
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
    const compiled = await compileModel(path)
    cds.model = compiled
    return compiled
  } catch {
    // If anything goes wrong, cds.model remains untouched
  }
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
