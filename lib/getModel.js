import fs from 'fs'
import path from 'path'
import { Worker } from 'node:worker_threads'

const compilerWorker = new URL('./compileModelWorker.js', import.meta.url)

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
      ? { model: await compileForProject(projectRoot), cdsFiles }
      : await compileAndSnapshot(projectRoot)
    activeProject = { root: projectRoot, ...result }
    return result.model
  } catch {
    // Preserve the last successfully compiled model and timestamp snapshot so the next request retries the refresh.
    return activeProject.model
  }
}

async function compileAndSnapshot(projectRoot) {
  let cdsFiles
  try {
    cdsFiles = await collectCdsFiles(projectRoot)
  } catch {
    // Compilation below provides the canonical error for missing or invalid projects.
  }

  const model = await compileForProject(projectRoot)
  if (!cdsFiles) {
    try {
      cdsFiles = await collectCdsFiles(projectRoot)
    } catch {
      // Keep the valid model without a snapshot; the next request will retry collection and compilation.
    }
  }
  return { model, cdsFiles }
}

// CAP compilation relies on process-global state and lazily initialized modules.
// A worker gives every compilation an isolated CAP instance without disturbing concurrent tools.
function compileForProject(projectRoot) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(compilerWorker, { workerData: { projectRoot } })
    let settled = false

    worker.once('message', result => {
      settled = true
      let model
      let resultError
      if (result.error) {
        resultError = new Error(result.error.message)
        resultError.name = result.error.name
        resultError.stack = result.error.stack
        if (result.error.code) resultError.code = result.error.code
      } else {
        try {
          model = JSON.parse(result.model)
        } catch (error) {
          resultError = error
        }
      }
      worker.terminate().then(
        () => (resultError ? reject(resultError) : resolve(model)),
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
