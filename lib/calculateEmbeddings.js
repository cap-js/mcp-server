import { writeFile, mkdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import cds from '@sap/cds'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
export const MODEL_FOLDER = MODEL.replace(/\//g, '_')
export const DEFAULT_DIR = path.join(__dirname, '..', 'embeddings')
export const DEFAULT_EMBEDDINGS_DIR = path.join(DEFAULT_DIR, MODEL_FOLDER)
export const DEFAULT_EMBEDDINGS_URL = `https://cap.cloud.sap/resources/embeddings/${MODEL_FOLDER}`

async function connectEmbedDb(dbFile, model = MODEL) {
  return cds.connect.to('embed-db', {
    kind: 'sqlite',
    embedding: { model },
    impl: '@cap-js/ai/lib/sqlite/AISQLiteService.js',
    credentials: { url: dbFile ?? ':memory:' }
  })
}

export async function createEmbeddings(id, chunks, dir = DEFAULT_DIR, { dbFile, metadata, capire, model = MODEL } = {}) {
  if (!chunks.length) throw new Error('No chunks to save')
  if (metadata !== undefined && metadata.length !== chunks.length)
    throw new Error('metadata length must match chunks length')

  const modelFolder = model.replace(/\//g, '_')
  const dirToken = capire.commitId
  const versionFolder = dirToken ? dirToken.replace(/[^a-zA-Z0-9.-]/g, '_') : null
  const outDir = versionFolder ? path.join(dir, modelFolder, versionFolder) : path.join(dir, modelFolder)
  if (dbFile) await unlink(dbFile).catch(() => {})

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

  await mkdir(outDir, { recursive: true })
  const binPath = path.join(outDir, `${id}.bin`)
  const jsonPath = path.join(outDir, `${id}.json`)
  await unlink(binPath).catch(() => {})
  await unlink(jsonPath).catch(() => {})
  await writeFile(binPath, Buffer.from(flat.buffer))
  const json = { dim, count: stored.length, model, chunks: orderedChunks }
  if (capire !== undefined) json.capire = capire
  if (metadata !== undefined) json.metadata = metadata
  await writeFile(jsonPath, JSON.stringify(json, null, 2))

  return { dim, count: stored.length, outDir, model }
}

let queryDb = null

async function getQueryDb() {
  if (queryDb) return queryDb
  queryDb = await connectEmbedDb(':memory:')
  return queryDb
}

export default async function calculateEmbeddings(text) {
  const db = await getQueryDb()
  const [row] = await db.run("SELECT VECTOR_EMBEDDING(?, 'QUERY', '') AS emb", [text])
  const vec = JSON.parse(row.emb)
  return Float32Array.from(vec)
}
