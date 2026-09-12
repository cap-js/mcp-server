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

let activeProject
let requestQueue = Promise.resolve()

export default function getModel(projectPath) {
  const projectRoot = path.resolve(projectPath)
  const request = requestQueue.then(
    () => loadProject(projectRoot),
    () => loadProject(projectRoot)
  )
  requestQueue = request.catch(() => {})
  return request
}

async function loadProject(projectRoot) {
  if (activeProject?.root !== projectRoot) {
    const { model, cdsFiles } = await compileAndSnapshot(projectRoot)
    activeProject = { root: projectRoot, model, cdsFiles }
    return model
  }

  let cdsFiles
  try {
    cdsFiles = await collectCdsFiles(projectRoot)
    if (activeProject.cdsFiles && !cdsFilesChanged(activeProject.cdsFiles, cdsFiles)) return activeProject.model
  } catch {
    // Treat an unreadable project as changed and let compilation decide whether the cached model remains usable.
  }

  try {
    const result = cdsFiles
      ? { model: await compileForProject(projectRoot, activeProject.model), cdsFiles }
      : await compileAndSnapshot(projectRoot, activeProject.model)
    activeProject = { root: projectRoot, ...result }
    return result.model
  } catch {
    // Preserve the last successfully compiled model and timestamp snapshot so the next request retries the refresh.
    return activeProject.model
  }
}

async function compileAndSnapshot(projectRoot, currentModel) {
  let cdsFiles
  try {
    cdsFiles = await collectCdsFiles(projectRoot)
  } catch {
    // Compilation below provides the canonical error for missing or invalid projects.
  }

  const model = await compileForProject(projectRoot, currentModel)
  if (!cdsFiles) {
    try {
      cdsFiles = await collectCdsFiles(projectRoot)
    } catch {
      // Keep the valid model without a snapshot; the next request will retry collection and compilation.
    }
  }
  return { model, cdsFiles }
}

// CDS uses process-global root, model, and environment state while resolving and compiling.
// Calls are serialized above; temporarily install the project's state and restore the previous values afterwards.
async function compileForProject(projectRoot, currentModel) {
  const previousRoot = cds.root
  const previousModel = cds.model
  const previousEnv = cds.env
  try {
    cds.root = projectRoot
    cds.env = previousEnv.for('cds', projectRoot)
    cds.model = currentModel
    return await compileModel(projectRoot)
  } finally {
    cds.model = previousModel
    cds.env = previousEnv
    cds.root = previousRoot
  }
}

// Loads and compiles the CDS model, or throws on error.
async function compileModel(projectPath) {
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

  return compiled
}

async function collectCdsFiles(projectPath) {
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

  return currentTimestamps
}

function cdsFilesChanged(previousTimestamps, currentTimestamps) {
  if (currentTimestamps.size !== previousTimestamps.size) return true
  for (const [file, timestamp] of currentTimestamps) {
    if (previousTimestamps.get(file) !== timestamp) return true
  }
  return false
}
