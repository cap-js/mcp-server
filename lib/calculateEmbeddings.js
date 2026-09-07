import { writeFile, mkdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import cds from '@sap/cds'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = path.join(__dirname, '..', 'embeddings')
const MODEL = 'perplexity-ai/pplx-embed-v1-0.6b'

async function connectEmbedDb(dbFile) {
  return cds.connect.to('embed-db', {
    kind: 'sqlite',
    embedding: { model: MODEL },
    impl: '@cap-js/ai/lib/sqlite/AISQLiteService.js',
    credentials: { url: dbFile ?? ':memory:' },
    embedding: { model: MODEL }
  })
}

export async function createEmbeddings(id, chunks, dir = DEFAULT_DIR, { dbFile } = {}) {
  if (!chunks.length) throw new Error('No chunks to save')
  if (dbFile) await unlink(dbFile).catch(() => {})

  const db = await connectEmbedDb(dbFile)

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

  await mkdir(dir, { recursive: true })
  const binPath = path.join(dir, `${id}.bin`)
  const jsonPath = path.join(dir, `${id}.json`)
  await unlink(binPath).catch(() => {})
  await unlink(jsonPath).catch(() => {})
  await writeFile(binPath, Buffer.from(flat.buffer))
  await writeFile(jsonPath, JSON.stringify({ dim, count: stored.length, chunks: orderedChunks }, null, 2))

  return { dim, count: stored.length, outDir: dir }
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
