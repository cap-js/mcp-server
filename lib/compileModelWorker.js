import { parentPort, workerData } from 'node:worker_threads'
import compileModel from './compileModel.js'

try {
  const model = await compileModel(workerData.projectRoot)
  parentPort.postMessage({ model: JSON.stringify(model) })
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
