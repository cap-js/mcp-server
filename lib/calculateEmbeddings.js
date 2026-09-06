import { writeFile, mkdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import cds from '@sap/cds'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = path.join(__dirname, '..', 'embeddings')

const esc = (s) => s.replace(/'/g, "''")

async function connectEmbedDb(dbFile) {
  return cds.connect.to('embed-db', {
    kind: 'sqlite',
    impl: '@cap-js/ai/lib/sqlite/AISQLiteService.js',
    credentials: { url: dbFile ?? ':memory:' }
  })
}

export async function createEmbeddings(id, chunks, dir = DEFAULT_DIR, { dbFile } = {}) {
  if (!chunks.length) throw new Error('No chunks to save')
  const startTime = Date.now()
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
  console.log('inserting', rows.length, 'rows...')
  for (const { ID, chunk } of rows) {
    await db.run(`INSERT INTO Docs(ID, chunk) VALUES ('${ID}', '${esc(chunk)}')`)
  }

  console.log('reading embeddings back...')
  const stored = await db.run('SELECT ID, chunk, emb FROM Docs')
  await db.disconnect()

  const byId = new Map(stored.map(r => [r.ID, r]))
  const firstVec = JSON.parse(stored[0].emb)
  const dim = firstVec.length
  const flat = new Float32Array(rows.length * dim)
  const orderedChunks = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const row = byId.get(rows[i].ID)
    if (!row) throw new Error(`missing row for ID ${rows[i].ID}`)
    const vec = JSON.parse(row.emb)
    if (vec.length !== dim) throw new Error(`row ${i} has ${vec.length} dims, expected ${dim}`)
    flat.set(vec, i * dim)
    orderedChunks[i] = row.chunk
  }

  await mkdir(dir, { recursive: true })
  const binPath = path.join(dir, `${id}.bin`)
  const jsonPath = path.join(dir, `${id}.json`)
  await unlink(binPath).catch(() => {})
  await unlink(jsonPath).catch(() => {})
  await writeFile(binPath, Buffer.from(flat.buffer))
  await writeFile(jsonPath, JSON.stringify({ dim, count: rows.length, chunks: orderedChunks }, null, 2))

  const elapsed = (Date.now() - startTime) / 1000
  console.log(`\n\nTook ${elapsed}s.\n\nEmbeddings written to ${dir}.`)
  return { dim, count: rows.length, outDir: dir }
}

let queryDb = null

async function getQueryDb() {
  if (queryDb) return queryDb
  queryDb = await connectEmbedDb(':memory:')
  return queryDb
}

export default async function calculateEmbeddings(text) {
  const db = await getQueryDb()
  const [row] = await db.run(`SELECT VECTOR_EMBEDDING('${esc(text)}', 'QUERY') AS emb`)
  const vec = JSON.parse(row.emb)
  return Float32Array.from(vec)
}
