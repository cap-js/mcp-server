import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { WorkspaceAccessError } from './projectPath.js'

const compilerWorker = new URL('./compileModelWorker.js', import.meta.url)

let activeProject
let requestQueue = Promise.resolve()

export default function getModel(projectPath, workspaceRoots = [projectPath]) {
  const projectRoot = path.resolve(projectPath)
  const allowedRoots = [...new Set(workspaceRoots.map(root => path.resolve(root)))]
  const request = requestQueue.then(
    () => loadProject(projectRoot, allowedRoots),
    () => loadProject(projectRoot, allowedRoots)
  )
  requestQueue = request.catch(() => {})
  return request
}

async function loadProject(projectRoot, workspaceRoots) {
  if (activeProject?.root !== projectRoot || !sameRoots(activeProject.workspaceRoots, workspaceRoots)) {
    const result = await compileAndSnapshot(projectRoot, workspaceRoots)
    activeProject = { root: projectRoot, workspaceRoots, ...result }
    return result.model
  }

  let cdsFiles
  try {
    cdsFiles = await collectModelFiles(projectRoot, activeProject.sourceFiles)
    if (activeProject.cdsFiles && !cdsFilesChanged(activeProject.cdsFiles, cdsFiles)) return activeProject.model
  } catch {
    // Treat an unreadable project as changed and let compilation decide whether the cached model remains usable.
  }

  try {
    const result = await compileAndSnapshot(projectRoot, workspaceRoots)
    activeProject = { root: projectRoot, workspaceRoots, ...result }
    return result.model
  } catch (error) {
    if (error instanceof WorkspaceAccessError) throw error
    // Preserve the last successfully compiled model and timestamp snapshot so the next request retries the refresh.
    return activeProject.model
  }
}

async function compileAndSnapshot(projectRoot, workspaceRoots) {
  let projectFiles
  try {
    projectFiles = await collectProjectFiles(projectRoot)
  } catch {
    // Compilation below provides the canonical error for missing or invalid projects.
  }

  const result = await compileForProject(projectRoot, workspaceRoots)
  if (!projectFiles) {
    try {
      projectFiles = await collectProjectFiles(projectRoot)
    } catch {
      // Keep the valid model without a snapshot; the next request will retry collection and compilation.
    }
  }

  const cdsFiles = projectFiles
    ? await fileSnapshot([...new Set([...projectFiles, ...result.sourceFiles])])
    : undefined
  return { ...result, cdsFiles }
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
        resultError =
          result.error.code === 'ERR_WORKSPACE_ACCESS' || result.error.name === 'WorkspaceAccessError'
            ? new WorkspaceAccessError(result.error.message)
            : new Error(result.error.message)
        resultError.name = result.error.name
        resultError.stack = result.error.stack
        if (result.error.code) resultError.code = result.error.code
      } else {
        try {
          compiled = { model: JSON.parse(result.model), sourceFiles: result.sourceFiles }
        } catch (error) {
          resultError = error
        }
      }
      worker.terminate().then(
        () => (resultError ? reject(resultError) : resolve(compiled)),
        reject
      )
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

async function collectModelFiles(projectPath, previousSources) {
  const projectFiles = await collectProjectFiles(projectPath)
  return fileSnapshot([...new Set([...projectFiles, ...previousSources])])
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
        if ((entry.isFile() && entry.name.endsWith('.cds')) || entry.isSymbolicLink()) return [fullPath]
        return []
      })
    )
    return results.flat()
  }

  return findFiles(projectPath)
}

async function fileSnapshot(files) {
  const snapshot = new Map()
  await Promise.all(
    files.map(async file => {
      try {
        const stat = await fs.promises.lstat(file)
        snapshot.set(file, stat.mtimeMs)
      } catch {
        // A source may disappear between discovery and stat.
      }
    })
  )
  return snapshot
}

function sameRoots(previousRoots, currentRoots) {
  return previousRoots?.length === currentRoots.length && previousRoots.every(root => currentRoots.includes(root))
}

function cdsFilesChanged(previousTimestamps, currentTimestamps) {
  if (currentTimestamps.size !== previousTimestamps.size) return true
  for (const [file, timestamp] of currentTimestamps) {
    if (previousTimestamps.get(file) !== timestamp) return true
  }
  return false
}
