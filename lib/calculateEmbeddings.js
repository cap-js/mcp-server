import fs from 'fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import cds from '@sap/cds'
import { installModel } from '@cap-js/ai/lib/vector_embedding/model-install.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
export const UNKNOWN_CDS_VERSION = "latest"
export let DEFAULT_DIR = path.join(__dirname, '..', 'embeddings')
export function setEmbeddingsDir(dir) { DEFAULT_DIR = dir }
export const DEFAULT_EMBEDDINGS_URL = `https://cap.cloud.sap/resources/embeddings`

let _activeModel = process.env.CDS_MCP_MODEL || MODEL
export function setActiveModel(m) { _activeModel = m || MODEL }
export function getActiveModel() { return _activeModel }
export function getActiveModelFolder() { return toDirName(_activeModel) }
export function getActiveEmbeddingsDir() { return path.join(DEFAULT_DIR, getActiveModelFolder()) }

export function toDirName(model) {
  return model.replace(/\//g, '--')
}

export const MODEL_CACHE_DIR = path.join(__dirname, '..', '.cds', 'models')

async function connectEmbedDb(dbFile, model = _activeModel) {
  const config = {
    kind: 'sqlite',
    embedding: { model, directory: MODEL_CACHE_DIR },
    impl: '@cap-js/ai/lib/sqlite/AISQLiteService.js',
    credentials: { url: dbFile ?? ':memory:' }
  }
  // REMOVE try catch when fixed in cap-js/ai plugin
  try {
    return await cds.connect.to('embed-db', config)
  } catch (error) {
    if (!/Embedding model lock not found/.test(error.message)) throw error
    await installModel(model, { directory: MODEL_CACHE_DIR })
    return cds.connect.to('embed-db', config)
  }
}

// only for docs-resources embeddings creation
export async function createEmbeddings(id, chunks, dir = DEFAULT_DIR, { dbFile, metadata, capire, model = _activeModel } = {}) {
  if (!chunks.length) throw new Error('No chunks to save')
  if (metadata !== undefined && metadata.length !== chunks.length)
    throw new Error('metadata length must match chunks length')

  const modelFolderName = toDirName(model)
  const versionFolder = capire?.commitId
  const outDir = versionFolder ? path.join(dir, modelFolderName, versionFolder) : path.join(dir, modelFolderName)
  if (dbFile) await fs.unlink(dbFile).catch(() => {})

  const db = await connectEmbedDb(dbFile, model)

  await db.run(`
    CREATE TABLE Docs (
      ID    TEXT PRIMARY KEY,
      chunk TEXT NOT NULL,
      emb   TEXT GENERATED ALWAYS AS (VECTOR_EMBEDDING(chunk, 'DOCUMENT')) STORED
    )
  `)

  const rows = chunks.map(c => ({ ID: randomUUID(), chunk: c }))
  const values = rows.map(() => '(?, ?)').join(',')
  const params = rows.flatMap(r => [r.ID, r.chunk])
  await db.run(`INSERT INTO Docs(ID, chunk) VALUES ${values}`, params)

  const stored = await db.run('SELECT chunk, emb FROM Docs ORDER BY rowid')
  await db.disconnect()

  const dim = JSON.parse(stored[0].emb).length
  const flat = new Float32Array(stored.length * dim)
  const orderedChunks = stored.map((r, i) => {
    flat.set(JSON.parse(r.emb), i * dim)
    return r.chunk
  })

  await fs.mkdir(outDir, { recursive: true })
  const binPath = path.join(outDir, `${id}.bin`)
  const jsonPath = path.join(outDir, `${id}.json`)
  await fs.unlink(binPath).catch(() => {})
  await fs.unlink(jsonPath).catch(() => {})
  await fs.writeFile(binPath, Buffer.from(flat.buffer))
  const json = { dim, count: stored.length, model, createdAt: new Date().toISOString(), chunks: orderedChunks }
  if (capire !== undefined) json.capire = capire
  if (metadata !== undefined) json.metadata = metadata
  await fs.writeFile(jsonPath, JSON.stringify(json, null, 2))

  return { dim, count: stored.length, outDir, modelFolderName }
}

let queryDb = null

export async function getQueryDb(model) {
  // fallback to _activeModel but model should always be defined by code-chunks.json
  const wanted = model ?? _activeModel
  if (queryDb) {
    const currModel = queryDb.options?.embedding?.model
    if (currModel === wanted) return queryDb
    await queryDb.disconnect()
  }
  queryDb = await connectEmbedDb(':memory:', wanted)
  return queryDb
}

export default async function calculateEmbeddings(text, model) {
  const db = await getQueryDb(model)
  const [row] = await db.run("SELECT VECTOR_EMBEDDING(?, 'QUERY', '') AS emb", [text])
  const vec = JSON.parse(row.emb)
  return Float32Array.from(vec)
}
