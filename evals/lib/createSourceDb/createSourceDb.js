import fs from 'fs/promises'
import cds from '@sap/cds'
import { randomUUID } from 'node:crypto'
import { runPipeline } from './pipeline/pipeline.js'

const { INSERT, SELECT } = cds.ql
const DEFAULT_SRC = new URL('llms-full.txt', import.meta.url).pathname

export async function createSourceDb() {
  let text
  try {
    text = await fs.readFile(DEFAULT_SRC, 'utf8')
  } catch (e) {
    const response = await fetch('https://cap.cloud.sap/docs/llms-full.txt');
    if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
    text = await response.text();
  }
  if (!runPipeline) throw Error('Need runPipeline from docs-resources')

  function toDb(chunk) {
    const meta = {
      headingPath: chunk.breadcrumb,
      source: chunk.source,
      title: chunk.heading,
      chunk: chunk.body,
      ID: randomUUID()
    }
    return meta;
  }
  const { sections } = runPipeline(text, {  
    maxHeadingDepth: Infinity,
    maxChunkSize: Infinity,
    minChunkSize: 0,
  })
  const entries = sections.map(toDb)
  const model = await cds.load(new URL('./source-docs.cds', import.meta.url).pathname)
  const sourceDb = await cds.connect.to(
    { 
      embedding: { model: 'sentence-transformers/all-MiniLM-L6-v2' },
      impl: '@cap-js/ai/lib/sqlite/AISQLiteService.js',
      kind: 'sqlite', 
      credentials: { url: ':memory:' } 
    }
  )
  await cds.deploy(model).to(sourceDb)

  await sourceDb.run(INSERT.into('SourceDocs').entries(entries))
  const textSources = text.split('\n')
    .filter(l => l.startsWith('> Source: /docs'))
    .map(l => 'https://cap.cloud.sap' + l.slice('> Source: '.length).trim())
  
  const indexed = new Set(
    (await sourceDb.run(SELECT('source').from('SourceDocs'))).map(r => r.source)
  )
  const missing = textSources.filter(s => !indexed.has(s))
  if (missing.length) console.log(`${missing.length} sources not in source db`)
  
  return sourceDb
}