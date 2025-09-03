import cds from '@sap/cds'
import fs from 'fs'
import path from 'path'

cds.log.Logger = () => {
  return {
    trace: () => {},
    debug: () => {},
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  }
}

// Ensures only one CDS model compilation is ever in-flight.
// The moment getModel is called, cds.model is set to a promise.
export default async function getModel(projectPath) {
  if (cds.model) {
    // If cds.model is a promise, await it; if it's resolved, return it
    if (typeof cds.model.then === 'function') await cds.model
    return cds.model
  }
  // Assign a promise immediately to cds.model to prevent duplicate compilations
  cds.model = (async () => {
    const compiled = await compileModel(projectPath)
    cds.model = compiled
    return compiled
  })()

  try {
    await cds.model
  } catch (e) {
    cds.model = undefined
    throw e
  }
  return cds.model
}

// Loads and compiles the CDS model, returns the compiled model or throws on error
async function compileModel(projectPath) {
  cds.root = projectPath
  const startTime = Date.now()
  const resolved = cds.resolve(projectPath + '/*', { cache: {} }) // use CAP standard resolution for model compilation
  if (!resolved) {
    throw new Error(`No CDS files in path: ${projectPath}`)
  }
  let compiled = await cds.load(resolved, { docs: true, locations: true })
  if (!compiled || (Array.isArray(compiled) && compiled.length === 0)) {
    throw new Error(`Failed to load CDS model from path: ${projectPath}`)
  }
  if (!compiled.definitions || Object.keys(compiled.definitions).length === 0) {
    throw new Error(`Compiled CDS model is invalid or empty for path: ${projectPath}`)
  }
  compiled = cds.compile.for.nodejs(compiled) // to include drafts, show effective types
  const serviceInfo = cds.compile.to.serviceinfo(compiled)

  // merge with definitions
  for (const info of serviceInfo) {
    const def = compiled.definitions[info.name]
    Object.assign(def, info)
  }

  for (const name in compiled.definitions) {
    Object.defineProperty(compiled.definitions[name], 'name', {
      value: name,
      enumerable: true
    })
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
      const hasChanged = await cdsFilesChanged(projectPath)
      if (hasChanged) {
        await refreshModel(projectPath)
      }
    }, intervalMs).unref() // Uses CDS_MCP_REFRESH_MS if set, otherwise defaults to 10x compile duration or 20s
  }
  return compiled
}

// Refreshes the CDS model, only replaces cds.model if compilation succeeds
async function refreshModel(projectPath) {
  try {
    const compiled = await compileModel(projectPath)
    cds.model = compiled
    return compiled
  } catch {
    // If anything goes wrong, cds.model remains untouched
  }
}

// Global cache object for CDS file timestamps
const cache = { cdsFiles: new Map() }
let changeWatcher = null

async function cdsFilesChanged(projectPath) {
  // Recursively find all .cds files under root, ignoring node_modules
  async function findCdsFiles(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    const promises = entries.map(async entry => {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') return []
        return await findCdsFiles(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.cds')) {
        return [fullPath]
      } else {
        return []
      }
    })
    const results = await Promise.all(promises)
    return results.flat()
  }

  if (projectPath.endsWith('/')) projectPath = projectPath.slice(0, -1)
  const files = await findCdsFiles(projectPath)
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
