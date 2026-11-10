import assert from 'node:assert/strict'
import { after, afterEach, describe, it, mock } from 'node:test'

const originalEnv = {
  CDS_MCP_OFFLINE: process.env.CDS_MCP_OFFLINE,
  CDS_MCP_OFFLINE_DIR: process.env.CDS_MCP_OFFLINE_DIR,
  CDS_MCP_RERANK_ENABLED: process.env.CDS_MCP_RERANK_ENABLED,
  CDS_MCP_GENERIC_EMBEDDINGS: process.env.CDS_MCP_GENERIC_EMBEDDINGS
}
process.env.CDS_MCP_OFFLINE = 'true'
process.env.CDS_MCP_OFFLINE_DIR = '/initial/generated/output'
process.env.CDS_MCP_RERANK_ENABLED = 'false'
process.env.CDS_MCP_GENERIC_EMBEDDINGS = 'true'

const loadChunks = mock.fn(async () => {
  const chunks = [{ content: 'Generated documentation.', embeddings: new Float32Array([1]) }]
  chunks.model = 'fixture/generated-model'
  return chunks
})
const hybridSearch = mock.fn(async (_query, chunks) => chunks)
mock.module('../lib/embeddings.js', { namedExports: { loadChunks, hybridSearch } })

const { default: searchMarkdownDocs } = await import('../lib/searchMarkdownDocs.js')

afterEach(() => {
  loadChunks.mock.resetCalls()
  hybridSearch.mock.resetCalls()
})
after(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('offline directory selection', () => {
  it('should defer loading the bundle until a search is requested', () => {
    assert.equal(loadChunks.mock.callCount(), 0)
    assert.equal(hybridSearch.mock.callCount(), 0)
  })

  it('should use the current override on each search without downloading', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', () =>
      assert.fail('Must not download in offline mode')
    )

    for (const dir of ['/first/generated/output', '/second/generated/output']) {
      process.env.CDS_MCP_OFFLINE_DIR = dir

      const result = await searchMarkdownDocs('documentation', 1)

      assert.equal(result, 'Generated documentation.')
      assert.deepEqual(loadChunks.mock.calls.at(-1).arguments, ['code-chunks', dir])
      assert.equal(hybridSearch.mock.calls.at(-1).arguments[1].model, 'fixture/generated-model')
    }
    assert.equal(loadChunks.mock.callCount(), 2)
    assert.equal(fetchMock.mock.callCount(), 0)
  })
})
