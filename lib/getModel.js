import cds from '@sap/cds'
import fs from 'node:fs'
import path from 'node:path'
import { WorkspaceAccessError, resolvePathsWithinRoots } from './projectPath.js'

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

export default function getModel(projectPath, workspaceRoots = [projectPath]) {
  const projectRoot = path.resolve(projectPath)
  const request = requestQueue.then(
    () => loadProject(projectRoot, workspaceRoots),
    () => loadProject(projectRoot, workspaceRoots)
  )
  requestQueue = request.catch(() => {})
  return request
}

async function loadProject(projectRoot, workspaceRoots) {
  if (activeProject?.root !== projectRoot) {
    const result = await compileForProject(projectRoot, undefined, workspaceRoots)
    activeProject = { root: projectRoot, ...result }
    return result.model
  }

  await validateModelSources(activeProject.sourceFiles, workspaceRoots)
  let cdsFiles
  try {
    cdsFiles = await collectModelFiles(projectRoot, activeProject.sourceFiles, workspaceRoots)
    if (activeProject.cdsFiles && !cdsFilesChanged(activeProject.cdsFiles, cdsFiles)) return activeProject.model
  } catch (error) {
    if (error instanceof WorkspaceAccessError) throw error
    // Treat an unreadable project as changed and let compilation decide whether the cached model remains usable.
  }

  try {
    const result = await compileForProject(projectRoot, activeProject.model, workspaceRoots)
    activeProject = { root: projectRoot, ...result }
    return result.model
  } catch (error) {
    if (error instanceof WorkspaceAccessError) throw error
    // Preserve the last successfully compiled model and timestamp snapshot so the next request retries the refresh.
    return activeProject.model
  }
}

// CDS uses process-global root, model, and environment state while resolving and compiling.
// Calls are serialized above; temporarily install the project's state and restore the previous values afterwards.
async function compileForProject(projectRoot, currentModel, workspaceRoots) {
  const previousRoot = cds.root
  const previousModel = cds.model
  const previousEnv = cds.env
  try {
    cds.root = projectRoot
    cds.env = previousEnv.for('cds', projectRoot)
    cds.model = currentModel
    return await compileModel(projectRoot, workspaceRoots)
  } finally {
    cds.model = previousModel
    cds.env = previousEnv
    cds.root = previousRoot
  }
}

async function compileModel(projectPath, workspaceRoots) {
  const resolved = resolveModelFiles(projectPath)
  if (!resolved) throw new Error(`No CDS files in path: ${projectPath}`)

  await validateModelSources(resolved, workspaceRoots)
  let compiled = await cds.load(resolved, { docs: true, locations: true })
  if (!compiled || (Array.isArray(compiled) && compiled.length === 0)) {
    throw new Error(`Failed to load CDS model from path: ${projectPath}`)
  }
  if (!compiled.definitions || Object.keys(compiled.definitions).length === 0) {
    throw new Error(`Compiled CDS model is invalid or empty for path: ${projectPath}`)
  }

  const sourceFiles = await validateModelSources(compiled.$sources || resolved, workspaceRoots)
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

  return { model: compiled, sourceFiles, cdsFiles: await fileSnapshot(sourceFiles) }
}

async function collectModelFiles(projectPath, previousSources, workspaceRoots) {
  const entryFiles = resolveModelFiles(projectPath) || []
  const sources = [...new Set([...entryFiles, ...previousSources])]
  return fileSnapshot(await validateModelSources(sources, workspaceRoots))
}

function resolveModelFiles(projectPath) {
  const resolved = cds.resolve(path.join(projectPath, '*'), { cache: {} })
  return resolved && [resolved].flat()
}

async function validateModelSources(files, workspaceRoots) {
  return resolvePathsWithinRoots(files, [...workspaceRoots, cds.home])
}

async function fileSnapshot(files) {
  const snapshot = new Map()
  await Promise.all(
    files.map(async file => {
      try {
        const stat = await fs.promises.stat(file)
        snapshot.set(file, stat.mtimeMs)
      } catch {
        // A source may disappear between resolution and stat.
      }
    })
  )
  return snapshot
}

function cdsFilesChanged(previousTimestamps, currentTimestamps) {
  if (currentTimestamps.size !== previousTimestamps.size) return true
  for (const [file, timestamp] of currentTimestamps) {
    if (previousTimestamps.get(file) !== timestamp) return true
  }
  return false
}
