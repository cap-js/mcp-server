import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'path'
import { fileURLToPath } from 'url'
import cds from '@sap/cds'
import { runPipeline } from './chunker/pipeline.js'
import { mergeConfig } from './chunker/config.js'


const FALLBACK_URL = 'https://cap.cloud.sap/docs/llms-full.txt';
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function parseArgs(argv) {
  const overrides = {};
  let input = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--max-chunk-size':   overrides.maxChunkSize = argv[++i];    break;
      case '--min-chunk-size':   overrides.minChunkSize = argv[++i];    break;
      case '--max-heading-depth': overrides.maxHeadingDepth = argv[++i]; break;
      case '--output':           overrides.output = argv[++i];          break;
      default: input = arg; break;
    }
  }

  return { overrides, input };
}

export async function readInput(input) {
  if (!input) {
    const response = await fetch(FALLBACK_URL);
    if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
    return response.text();
  }
  return readFile(input, 'utf8');
}

export function embedText(chunk) {
  const parts = [chunk.heading, chunk.body];
  return parts.filter(Boolean).join('\n\n');
}

export function toMeta(chunk) {
  const meta = {
    headingPath: chunk.breadcrumb,
    source: chunk.source
  }
  if (chunk.label) meta.label = chunk.label;
  return meta;
}

const esc = (s) => s.replace(/'/g, "''");

export async function buildEmbeddings(sections, { outDir, id = 'code-chunks', dbFile } = {}) {
  const startTime = Date.now()
  if (dbFile) await unlink(dbFile).catch(() => {})

  const db = await cds.connect.to('embed-db', {
    kind: 'sqlite',
    impl: '@cap-js/ai/lib/sqlite/AISQLiteService.js',
    credentials: { url: dbFile ?? ':memory:' }
  })

  await db.run(`
    CREATE TABLE Docs (
      ID    TEXT PRIMARY KEY,
      chunk TEXT NOT NULL,
      emb   TEXT GENERATED ALWAYS AS (VECTOR_EMBEDDING(chunk, 'DOCUMENT')) STORED
    )
  `)

  const rows = sections.map(s => ({ ID: randomUUID(), chunk: embedText(s) }))
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

  await mkdir(outDir, { recursive: true })
  const binPath = path.join(outDir, `${id}.bin`)
  const jsonPath = path.join(outDir, `${id}.json`)
  await writeFile(binPath, Buffer.from(flat.buffer))
  await writeFile(jsonPath, JSON.stringify({
    dim,
    count: rows.length,
    chunks: orderedChunks,
    metadata: sections.map(toMeta)
  }, null, 2))

  const elapsed = (Date.now() - startTime) / 1000
  console.log(`\n\nTook ${elapsed}s.\n\nEmbeddings written to ${outDir}.`)
  return { dim, count: rows.length, outDir }
}

export async function main() {
  const { overrides, input } = parseArgs(process.argv.slice(2))
  const config = mergeConfig(overrides)
  const text = await readInput(input || config.input);
  console.log('running chunking pipeline...')

  const { sections } = runPipeline(text, config)
  console.log('total', sections.length, 'sections')

  const outDir = path.join(__dirname, '..', 'embeddings')
  const dbFile = path.join(__dirname, '..', 'db.sqlite')
  await buildEmbeddings(sections, { outDir, dbFile })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  }).finally(() => process.exit(0));
}
