import { mock } from 'node:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Tiny deterministic models stand in for ONNX weights; every network-capable
// boundary records whether it is permitted to use the network.
const cache = process.env.CDS_MCP_TEST_CACHE
const log = (event) =>
  fs.appendFileSync(path.join(cache, 'calls.jsonl'), JSON.stringify(event) + '\n')
const modelPath = (model) => path.join(cache, 'models', model.replaceAll('/', '--'))
const available = (model) => {
  try {
    return fs.readFileSync(modelPath(model), 'utf8') === 'valid'
  } catch {
    return false
  }
}
const provision = (model) => {
  fs.mkdirSync(path.dirname(modelPath(model)), { recursive: true })
  fs.writeFileSync(modelPath(model), 'valid')
}

async function installModel(model, options) {
  log({ kind: 'install', model, options })
  if (process.env.CDS_MCP_TEST_NO_NETWORK === 'true') throw new Error('Model download forbidden')
  provision(model)
  return { model, modelDir: modelPath(model), modelRoot: path.dirname(modelPath(model)) }
}

mock.module('@cap-js/ai/models.js', { namedExports: { installModel } })
mock.module('@sap/cds', {
  defaultExport: {
    connect: {
      to: async (_name, options) => {
        const { model, offline } = options.embedding
        log({ kind: 'connection', embedding: options.embedding })
        if (process.env.CDS_MCP_TEST_INVALID_OVERRIDE === 'true')
          throw new Error('Invalid package-local model override; explicitly repair or remove it')
        if (!available(model)) {
          if (offline) {
            const diagnostic = fs.existsSync(modelPath(model))
              ? 'Embedding model is not provisioned or failed integrity checks.'
              : `Embedding model '${model}' is not available in offline mode.`
            throw new Error(`${diagnostic} Run 'npx @cap-js/ai install-model ${model}'.`)
          }
          await installModel(model)
        }
        return {
          options,
          disconnect: async () => {},
          run: async (sql) => (sql.startsWith('SELECT') ? [{ emb: '[1,0]' }] : [])
        }
      }
    }
  }
})

async function pretrained(kind, model, options = {}) {
  log({ kind, model, options })
  if (!available(`${model}-${kind}`)) {
    if (options.local_files_only) throw new Error(`Missing local ${kind}`)
    if (process.env.CDS_MCP_TEST_NO_NETWORK === 'true')
      throw new Error('Reranker download forbidden')
    log({ kind: 'reranker-download', model, component: kind })
    provision(`${model}-${kind}`)
  }
  if (kind === 'tokenizer') return (queries) => ({ queries })
  return async ({ queries }) => ({ logits: { tolist: () => queries.map(() => [1]) } })
}
mock.module('@huggingface/transformers', {
  namedExports: {
    AutoTokenizer: { from_pretrained: (model, options) => pretrained('tokenizer', model, options) },
    AutoModelForSequenceClassification: {
      from_pretrained: (model, options) => pretrained('reranker', model, options)
    }
  }
})

globalThis.fetch = async (_url, options = {}) => {
  log({ kind: 'fetch', headers: options.headers })
  if (process.env.CDS_MCP_TEST_NO_NETWORK === 'true') throw new Error('Network forbidden')
  if (process.env.CDS_MCP_TEST_FETCH_FAIL === 'true') throw new Error('Bundle server unavailable')
  if (options.headers?.['If-None-Match'] === 'W/"fixture"')
    return new Response(null, { status: 304 })
  const model =
    process.env.CDS_MCP_TEST_BUNDLE_MODEL || process.env.CDS_MCP_MODEL || 'BAAI/bge-small-en-v1.5'
  const meta = Buffer.from(
    process.env.CDS_MCP_TEST_CORRUPT_BUNDLE === 'true'
      ? 'invalid JSON'
      : JSON.stringify({ dim: 2, count: 2, model, chunks: ['entity Books', 'service Catalog'] })
  )
  const header = Buffer.alloc(4)
  header.writeUInt32BE(meta.length)
  const bin = Buffer.from(new Float32Array([1, 0, 0, 1]).buffer)
  return new Response(Buffer.concat([header, meta, bin]), {
    headers: {
      'x-embeddings-version': 'fixture',
      'x-embeddings-model': process.env.CDS_MCP_MODEL || 'BAAI/bge-small-en-v1.5',
      etag: 'W/"fixture"'
    }
  })
}

// Remap only the package documentation cache without importing application
// modules before the CLI has applied --model.
const packageEmbeddings = fileURLToPath(new URL('../../embeddings', import.meta.url))
const remap = (file) => {
  if (typeof file !== 'string') return file
  const relative = path.relative(packageEmbeddings, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    ? path.join(cache, 'embeddings', relative)
    : file
}
for (const name of ['readFile', 'writeFile', 'access', 'mkdir', 'readdir', 'stat', 'unlink']) {
  const original = fsp[name].bind(fsp)
  mock.method(fsp, name, (file, ...args) => original(remap(file), ...args))
}
const rename = fsp.rename.bind(fsp)
mock.method(fsp, 'rename', (from, to) => rename(remap(from), remap(to)))
