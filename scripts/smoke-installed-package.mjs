import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [installedRoot, expectedRuntime] = process.argv.slice(2)
const requirePackage = createRequire(path.join(installedRoot, 'package.json'))
const requireAi = createRequire(
  requirePackage.resolve('@cap-js/ai/lib/vector_embedding/SynchronousInferenceSession.js')
)
const requireTransformers = createRequire(requirePackage.resolve('@huggingface/transformers'))
const bindingPath = requireAi.resolve('onnxruntime-node/dist/binding.js')
const runtimeVersion = requireAi('onnxruntime-node/package.json').version

console.log({
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  runtimeVersion,
  bindingPath
})
for (const requireRuntime of [requirePackage, requireAi, requireTransformers]) {
  assert.equal(
    requireRuntime('onnxruntime-node/package.json').version,
    expectedRuntime || runtimeVersion,
    'Every runtime consumer must resolve the same ONNX Runtime version'
  )
}

// search_docs co-loads Transformers and the SQLite embedding runtime, even without reranking.
await import(pathToFileURL(path.join(installedRoot, 'lib', 'rerank.js')))
assert.equal(
  typeof requireAi('onnxruntime-node/dist/binding.js').binding.InferenceSession,
  'function'
)
console.log('Native ONNX binding loaded')

const embeddings = await import(
  pathToFileURL(path.join(installedRoot, 'lib', 'calculateEmbeddings.js'))
)
const query = '@flow.status annotation'
const document = 'A documentation fixture for @flow.status annotation.'
let queryDb
try {
  queryDb = await embeddings.getQueryDb()
  const vector = await embeddings.default(query)
  assert.ok(vector instanceof Float32Array)
  assert.equal(vector.length, 384)
  assert.ok(vector.every(Number.isFinite))
  const norm = Math.hypot(...vector)
  assert.ok(Math.abs(norm - 1) < 0.001, `Embedding must be normalized, got ${norm}`)

  await embeddings.createEmbeddings('code-chunks', [document], [document], {
    capire: { commitId: 'package-smoke' }
  })
} finally {
  await queryDb?.disconnect()
}
console.log('Native embedding inference passed')

const result = execFileSync(
  process.execPath,
  [...process.execArgv, path.join(installedRoot, 'index.js'), '--offline', 'search_docs', query, '1'],
  { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'inherit'] }
)
assert.ok(
  result.includes(document),
  'The installed CLI must return the seeded documentation fixture'
)
console.log('Installed search_docs CLI passed')
