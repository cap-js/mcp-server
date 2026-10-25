// Test bundle fixtures and setup helpers.
//
// A "bundle" is the server's binary frame: [4-byte BE meta length][meta JSON][bin].
// `buildTestBundle` builds a real embeddings frame from TEST_CHUNKS.

export const TEST_CHUNKS = [
  'To create a new CAP project, run: cds init my-project. The cds init command scaffolds a minimal project.',
  'Use cds add hana to add HANA support. First run cds init to bootstrap the project structure.',
  'Enterprise messaging in CAP uses enterprise-messaging as the service binding kind in package.json under cds.requires.',
  'SAP Event Mesh (enterprise-messaging) enables async messaging between microservices in CAP applications.',
  'Define CDS entities: entity Books { key ID: Integer; title: String; author: Association to Authors; }',
  'Expose entities via services: service CatalogService { entity Books as projection on my.Books; }',
  'CQL SELECT statement syntax: SELECT from Books where title = :title order by title asc',
  'Register custom event handlers to add business logic to a CAP service.',
  'Register custom event handlers to add business logic to a CAP service.',
  'Register custom event handlers to add business logic to a CAP service.',
  'Provide localized texts for your model using i18n properties files.',
  'Provide localized texts for your model using i18n properties files.'
]

// Parallel metadata for TEST_CHUNKS: distinct labels for the runtime-specific
// duplicate trio so the surviving copy is identifiable; no label on the
// no-runtime duplicate pair to cover the label-free dedup path.
const _DEFAULT_METADATA = [
  { headingPath: 'Alpha > Init', source: 'https://example.test/docs/alpha#init' },
  { headingPath: 'Alpha > Init', source: 'https://example.test/docs/alpha#hana', label: 'node' },
  { headingPath: 'Beta > Messaging', source: 'https://example.test/docs/beta#em', label: 'node' },
  { headingPath: 'Beta > Messaging', source: 'https://example.test/docs/beta#mesh' },
  { headingPath: 'Gamma > Data', source: 'https://example.test/docs/gamma#entities' },
  { headingPath: 'Gamma > Data', source: 'https://example.test/docs/gamma#services' },
  { headingPath: 'Gamma > Query', source: 'https://example.test/docs/gamma#cql' },
  { headingPath: 'Delta > Dedup', source: 'https://example.test/docs/delta#dedup', label: 'node' },
  { headingPath: 'Delta > Dedup', source: 'https://example.test/docs/delta#dedup', label: 'java' },
  { headingPath: 'Delta > Dedup', source: 'https://example.test/docs/delta#dedup' },
  { headingPath: 'Epsilon > Generic', source: 'https://example.test/docs/epsilon#a' },
  { headingPath: 'Epsilon > Generic', source: 'https://example.test/docs/epsilon#b' }
]

export async function buildTestBundle({
  chunks = TEST_CHUNKS,
  metadata = chunks === TEST_CHUNKS ? _DEFAULT_METADATA : undefined
} = {}) {
  const { default: calculateEmbeddings } = await import('../../lib/calculateEmbeddings.js')
  const vecs = await Promise.all(chunks.map((chunk) => calculateEmbeddings(chunk)))
  const dim = vecs[0].length
  const flat = new Float32Array(chunks.length * dim)
  for (let i = 0; i < vecs.length; i++) flat.set(vecs[i], i * dim)
  const meta = { dim, count: chunks.length, chunks }
  if (metadata) meta.metadata = metadata
  const metaBuf = Buffer.from(JSON.stringify(meta))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(metaBuf.length, 0)
  return Buffer.concat([header, metaBuf, Buffer.from(flat.buffer)])
}
