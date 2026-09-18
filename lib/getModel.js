import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { resolvePathsWithinRoots, WorkspaceAccessError } from './projectPath.js'

const compilerWorker = new URL('./compileModelWorker.js', import.meta.url)
const PROJECT_CONFIG_FILES = new Set([
  '.cdsrc.js',
  '.cdsrc.json',
  '.cdsrc.yaml',
  '.cdsrc-private.json',
  '.env',
  'default-env.json',
  'package.json'
])
const MAX_COMPILE_ATTEMPTS = 2

// Deliberately keep one project snapshot: the stdio server normally serves one active workspace, and retaining
// arbitrary CSNs would grow memory without a bound. Alternating projects therefore recompile.
let activeProject
// Serialize cache inspection and replacement so callers observe models in request order across project switches.
let requestQueue = Promise.resolve()

export default function getModel(projectPath, workspaceRoots = [projectPath]) {
  const projectRoot = path.resolve(projectPath)
  const allowedRoots = workspaceRoots && [...new Set(workspaceRoots.map(root => path.resolve(root)))]
  const request = requestQueue.then(
    () => loadProject(projectRoot, allowedRoots),
    () => loadProject(projectRoot, allowedRoots)
  )
  requestQueue = request.catch(() => {})
  return request
}

async function loadProject(projectRoot, workspaceRoots) {
  if (activeProject?.root !== projectRoot) {
    const result = await compileAndSnapshot(projectRoot, workspaceRoots)
    activeProject = { root: projectRoot, ...result }
    return result.model
  }

  if (workspaceRoots) {
    try {
      await resolvePathsWithinRoots(activeProject.sourceFiles, [...workspaceRoots, activeProject.compilerRoot])
    } catch (error) {
      if (error instanceof WorkspaceAccessError) throw error
      // A missing or unreadable source is handled as a model change below.
    }
  }

  let projectSnapshot
  try {
    projectSnapshot = await collectModelFiles(projectRoot, activeProject.sourceFiles, activeProject.configurationFiles)
    if (activeProject.projectSnapshot && !filesChanged(activeProject.projectSnapshot, projectSnapshot)) {
      return activeProject.model
    }
  } catch {
    // Treat an unreadable project as changed and let compilation decide whether the cached model remains usable.
  }

  try {
    const result = await compileAndSnapshot(projectRoot, workspaceRoots, [
      ...activeProject.sourceFiles,
      ...activeProject.configurationFiles
    ])
    activeProject = { root: projectRoot, ...result }
    return result.model
  } catch (error) {
    if (error instanceof WorkspaceAccessError) throw error
    // Preserve the last successfully compiled model and timestamp snapshot so the next request retries the refresh.
    return activeProject.model
  }
}

async function compileAndSnapshot(projectRoot, workspaceRoots, previousFiles = []) {
  let knownFiles = previousFiles
  for (let attempt = 0; attempt < MAX_COMPILE_ATTEMPTS; attempt++) {
    let beforeSnapshot
    try {
      const projectFiles = await collectProjectFiles(projectRoot)
      beforeSnapshot = await fileSnapshot([...new Set([...projectFiles, ...knownFiles])])
    } catch {
      // Compilation below provides the canonical error for missing or invalid projects.
    }

    const result = await compileForProject(projectRoot, workspaceRoots)
    let projectFiles
    try {
      projectFiles = await collectProjectFiles(projectRoot)
    } catch {
      // Keep the valid model without a snapshot; the next request will retry collection and compilation.
      return { ...result, projectSnapshot: undefined }
    }

    const trackedFiles = [
      ...new Set([...projectFiles, ...knownFiles, ...result.sourceFiles, ...result.configurationFiles])
    ]
    const trackedSnapshot = await fileSnapshot(trackedFiles)
    if (beforeSnapshot) {
      const dependencies = [...result.sourceFiles, ...result.configurationFiles]
      const afterSnapshot = selectSnapshot(trackedSnapshot, [...projectFiles, ...knownFiles])
      const discoveredDependency =
        result.sourceFiles.some(file => !beforeSnapshot.has(path.resolve(file))) ||
        result.configurationFiles.some(file => !isInstalledDependency(file) && !beforeSnapshot.has(path.resolve(file)))
      if (filesChanged(beforeSnapshot, afterSnapshot) || discoveredDependency) {
        if (attempt + 1 < MAX_COMPILE_ATTEMPTS) {
          knownFiles = [...new Set([...knownFiles, ...dependencies])]
          continue
        }
        return { ...result, projectSnapshot: undefined }
      }
    }

    const projectSnapshot = selectSnapshot(trackedSnapshot, [
      ...projectFiles,
      ...result.sourceFiles,
      ...result.configurationFiles
    ])
    return { ...result, projectSnapshot }
  }
}

// CAP compilation relies on process-global state and lazily initialized modules.
// A worker gives every compilation an isolated CAP instance without disturbing concurrent tools.
function compileForProject(projectRoot, workspaceRoots) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(compilerWorker, { workerData: { projectRoot, workspaceRoots } })
    let settled = false

    worker.once('message', result => {
      settled = true
      let compiled
      let resultError
      if (result.error) {
        const workerError = new Error(result.error.message)
        workerError.name = result.error.name
        workerError.stack = result.error.stack
        if (result.error.code) workerError.code = result.error.code
        if (result.error.code === 'ERR_WORKSPACE_ACCESS' || result.error.name === 'WorkspaceAccessError') {
          resultError = new WorkspaceAccessError(result.error.message, { cause: workerError })
        } else {
          resultError = workspaceRoots ? new Error('Failed to compile CDS model', { cause: workerError }) : workerError
        }
      } else {
        try {
          compiled = {
            // Workers return a serializable CSN snapshot. Current consumers only inspect enumerable CSN data.
            model: JSON.parse(result.model),
            sourceFiles: result.sourceFiles,
            configurationFiles: result.configurationFiles,
            compilerRoot: result.compilerRoot
          }
        } catch (error) {
          resultError = error
        }
      }
      worker.terminate().then(() => (resultError ? reject(resultError) : resolve(compiled)), reject)
    })
    worker.once('error', error => {
      if (settled) return
      settled = true
      worker.terminate().then(
        () => reject(error),
        () => reject(error)
      )
    })
    worker.once('exit', code => {
      if (!settled) {
        settled = true
        reject(new Error(`CDS compiler worker exited before returning a model (code ${code})`))
      }
    })
  })
}

async function collectModelFiles(projectPath, previousSources, previousConfigurationFiles) {
  const projectFiles = await collectProjectFiles(projectPath)
  return fileSnapshot([...new Set([...projectFiles, ...previousSources, ...previousConfigurationFiles])])
}

async function collectProjectFiles(projectPath) {
  async function findFiles(directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true })
    const results = await Promise.all(
      entries.map(async entry => {
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') return []
          return findFiles(fullPath)
        }
        if (
          (entry.isFile() &&
            (entry.name.endsWith('.cds') ||
              entry.name === 'pom.xml' ||
              (directory === projectPath &&
                (PROJECT_CONFIG_FILES.has(entry.name) || /^\..+\.env$/.test(entry.name))))) ||
          entry.isSymbolicLink()
        )
          return [fullPath]
        return []
      })
    )
    return results.flat()
  }

  return findFiles(projectPath)
}

async function fileSnapshot(files) {
  const snapshot = new Map()

  async function snapshotPath(file) {
    try {
      const stat = await fs.promises.lstat(file)
      snapshot.set(file, `${stat.mtimeMs}:${stat.size}`)
      if (!stat.isDirectory()) return
      const entries = await fs.promises.readdir(file)
      await Promise.all(entries.map(entry => snapshotPath(path.join(file, entry))))
    } catch {
      // A source may disappear between discovery and stat.
    }
  }

  await Promise.all(files.map(snapshotPath))
  return snapshot
}

function filesChanged(previousTimestamps, currentTimestamps) {
  if (currentTimestamps.size !== previousTimestamps.size) return true
  for (const [file, timestamp] of currentTimestamps) {
    if (previousTimestamps.get(file) !== timestamp) return true
  }
  return false
}

function selectSnapshot(snapshot, roots) {
  const resolvedRoots = roots.map(root => path.resolve(root))
  return new Map(
    [...snapshot].filter(([file]) =>
      resolvedRoots.some(root => {
        const relative = path.relative(root, file)
        return (
          relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
        )
      })
    )
  )
}

function isInstalledDependency(file) {
  return path.resolve(file).split(path.sep).includes('node_modules')
}
