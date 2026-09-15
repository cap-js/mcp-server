import { parentPort, workerData } from 'node:worker_threads'
import compileModel from './compileModel.js'

try {
  const { model, sourceFiles, compilerRoot } = await compileModel(workerData.projectRoot, workerData.workspaceRoots)
  parentPort.postMessage({ model: JSON.stringify(model), sourceFiles, compilerRoot })
} catch (error) {
  parentPort.postMessage({
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code
    }
  })
}
