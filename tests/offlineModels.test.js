import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../index.js', import.meta.url))
const loader = new URL('./helpers/offline-runtime.js', import.meta.url).href
const defaultModel = 'BAAI/bge-small-en-v1.5'
const reranker = 'Xenova/ms-marco-MiniLM-L-6-v2'

async function fixture(
  t,
  { model = defaultModel, queryModel = 'valid', rerank = false, docs = true } = {}
) {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-offline-'))
  t.after(() => fs.rm(cache, { recursive: true, force: true }))
  if (docs) {
    const dir = path.join(cache, 'embeddings', model.replaceAll('/', '--'), 'fixture')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'code-chunks.json'),
      JSON.stringify({ dim: 2, count: 2, model, chunks: ['entity Books', 'service Catalog'] })
    )
    await fs.writeFile(
      path.join(dir, 'code-chunks.bin'),
      Buffer.from(new Float32Array([1, 0, 0, 1]).buffer)
    )
  }
  await fs.mkdir(path.join(cache, 'models'))
  if (queryModel)
    await fs.writeFile(path.join(cache, 'models', model.replaceAll('/', '--')), queryModel)
  if (rerank) {
    for (const kind of ['tokenizer', 'reranker'])
      await fs.writeFile(
        path.join(cache, 'models', `${reranker.replaceAll('/', '--')}-${kind}`),
        'valid'
      )
  }
  const env = { ...process.env, CDS_MCP_TEST_CACHE: cache, RERANK_ENABLED: 'false' }
  delete env.CDS_MCP_OFFLINE
  delete env.CDS_MCP_MODEL
  const run = async (args, extra = {}) => {
    try {
      return {
        code: 0,
        ...(await execute(
          process.execPath,
          ['--experimental-test-module-mocks', '--import', loader, cli, ...args],
          { env: { ...env, ...extra }, cwd: cache }
        ))
      }
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr }
    }
  }
  const calls = async () =>
    (await fs.readFile(path.join(cache, 'calls.jsonl'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
  return { cache, run, calls }
}

async function seedManifest(cache, { model = defaultModel, lastChecked = Date.now() } = {}) {
  const etagPath = path.join(
    cache,
    'embeddings',
    model.replaceAll('/', '--'),
    'etags',
    'latest',
    'manifest.etag'
  )
  await fs.mkdir(path.dirname(etagPath), { recursive: true })
  await fs.writeFile(
    etagPath,
    JSON.stringify({ etag: 'W/"fixture"', commitId: 'fixture', model, lastChecked })
  )
  return etagPath
}

for (const args of [['--download'], ['search_docs', 'entity']]) {
  for (const lastChecked of [0, Date.now()]) {
    test(`${args[0]} repairs a corrupt ${lastChecked ? 'fresh' : '304'} cached bundle in one invocation`, async (t) => {
      const model = 'test/custom'
      const { cache, run, calls } = await fixture(t, { model })
      const etagPath = await seedManifest(cache, { model, lastChecked })
      const metaPath = path.join(
        cache,
        'embeddings',
        model.replaceAll('/', '--'),
        'fixture',
        'code-chunks.json'
      )
      await fs.writeFile(metaPath, 'invalid JSON')
      const result = await run(['--model', model, ...args])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(JSON.parse(await fs.readFile(metaPath, 'utf8')).model, model)
      const events = await calls()
      const requests = events.filter(({ kind }) => kind === 'fetch')
      assert.equal(requests.length, lastChecked ? 1 : 2)
      assert.equal(requests.at(-1).headers?.['If-None-Match'], undefined)
      assert.equal(events.find(({ kind }) => kind === 'connection').embedding.model, model)
      assert.equal(JSON.parse(await fs.readFile(etagPath, 'utf8')).etag, 'W/"fixture"')
      const requestCount = requests.length
      const again = await run(['--model', model, ...args])
      assert.equal(again.code, 0, again.stderr)
      assert.equal((await calls()).filter(({ kind }) => kind === 'fetch').length, requestCount)
    })
  }
}

for (const args of [['--download'], ['search_docs', 'entity']]) {
  test(`${args[0]} ignores a stale ETag when the cached bundle files are missing`, async (t) => {
    const { cache, run, calls } = await fixture(t, { docs: false })
    await seedManifest(cache)
    const result = await run(args)
    assert.equal(result.code, 0, result.stderr)
    const requests = (await calls()).filter(({ kind }) => kind === 'fetch')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].headers?.['If-None-Match'], undefined)
  })

  test(`${args[0]} bounds corruption retries and leaves the next invocation able to refetch`, async (t) => {
    const { cache, run, calls } = await fixture(t, { docs: false, queryModel: null })
    const failed = await run(args, { CDS_MCP_TEST_CORRUPT_BUNDLE: 'true' })
    assert.equal(failed.code, 1)
    assert.match(failed.stderr, /Corrupted files/)
    const events = await calls()
    assert.equal(events.filter(({ kind }) => kind === 'fetch').length, 3)
    assert.equal(events.filter(({ kind }) => ['install', 'connection'].includes(kind)).length, 0)
    const etagPath = path.join(
      cache,
      'embeddings',
      defaultModel.replaceAll('/', '--'),
      'etags',
      'latest',
      'manifest.etag'
    )
    await assert.rejects(fs.access(etagPath), { code: 'ENOENT' })
    const recovered = await run(args)
    assert.equal(recovered.code, 0, recovered.stderr)
    assert.equal((await calls()).filter(({ kind }) => kind === 'fetch').length, 4)
  })
}

for (const flag of ['cli', 'env']) {
  test(`${flag} offline search makes zero network or model-install calls`, async (t) => {
    const { run, calls } = await fixture(t, { rerank: true })
    const result = await run(
      flag === 'cli' ? ['--offline', 'search_docs', 'entity', '1'] : ['search_docs', 'entity', '1'],
      {
        CDS_MCP_TEST_NO_NETWORK: 'true',
        RERANK_ENABLED: 'true',
        ...(flag === 'env' && { CDS_MCP_OFFLINE: 'true' })
      }
    )
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /entity Books/)
    const events = await calls()
    assert.equal(
      events.filter(({ kind }) => ['fetch', 'install', 'reranker-download'].includes(kind)).length,
      0
    )
    assert.equal(events.find(({ kind }) => kind === 'connection').embedding.offline, true)
    for (const kind of ['tokenizer', 'reranker'])
      assert.equal(events.find((event) => event.kind === kind).options.local_files_only, true)
  })
}

for (const queryModel of [null, 'corrupt']) {
  test(`offline ${queryModel || 'missing'} model fails locally with preparation hint`, async (t) => {
    const { run, calls } = await fixture(t, { model: 'test/custom', queryModel })
    const result = await run(['--offline', '--model', 'test/custom', 'search_docs', 'entity'], {
      CDS_MCP_TEST_NO_NETWORK: 'true'
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /cds-mcp --download --model test\/custom/)
    assert.equal(
      (await calls()).filter(({ kind }) => ['fetch', 'install'].includes(kind)).length,
      0
    )
  })
}

test('offline cached-bundle fallback uses its encoder, not the requested model', async (t) => {
  const { run, calls } = await fixture(t, { model: 'cached/encoder' })
  const result = await run(
    ['--offline', '--model', 'unavailable/request', 'search_docs', 'entity'],
    { CDS_MCP_TEST_NO_NETWORK: 'true' }
  )
  assert.equal(result.code, 0, result.stderr)
  assert.equal(
    (await calls()).find(({ kind }) => kind === 'connection').embedding.model,
    'cached/encoder'
  )
})

test('download prepares bundle-matching query model and enabled reranker for offline search', async (t) => {
  const { run, calls } = await fixture(t, {
    model: 'bundle/encoder',
    queryModel: null,
    docs: false
  })
  const prepared = await run(['--download', '--model', 'selected/model'], {
    CDS_MCP_TEST_BUNDLE_MODEL: 'bundle/encoder',
    RERANK_ENABLED: 'true'
  })
  assert.equal(prepared.code, 0, prepared.stderr)
  assert.equal(JSON.parse(prepared.stdout).model, 'bundle/encoder')
  const online = await calls()
  assert.deepEqual(
    online.filter(({ kind }) => kind === 'install').map(({ model }) => model),
    ['bundle/encoder']
  )
  assert.equal(online.filter(({ kind }) => kind === 'reranker-download').length, 2)
  const result = await run(['--offline', '--model', 'selected/model', 'search_docs', 'entity'], {
    CDS_MCP_TEST_NO_NETWORK: 'true',
    RERANK_ENABLED: 'true'
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(
    (await calls())
      .slice(online.length)
      .filter(({ kind }) => ['fetch', 'install', 'reranker-download'].includes(kind)).length,
    0
  )
})

test('download provisions the encoder selected by cached bundle fallback', async (t) => {
  const { run, calls } = await fixture(t, { model: 'cached/encoder', queryModel: null })
  const result = await run(['--download', '--model', 'unavailable/request'], {
    CDS_MCP_TEST_FETCH_FAIL: 'true'
  })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(
    (await calls()).filter(({ kind }) => kind === 'install').map(({ model }) => model),
    ['cached/encoder']
  )
})

test('download fails when the effective package-local model override is invalid', async (t) => {
  const { run, calls } = await fixture(t)
  const result = await run(['--download'], { CDS_MCP_TEST_INVALID_OVERRIDE: 'true' })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Invalid package-local model override/)
  assert.equal(result.stdout, '')
  const events = await calls()
  assert.equal(events.filter(({ kind }) => kind === 'install').length, 1)
  assert.equal(events.find(({ kind }) => kind === 'connection').embedding.model, defaultModel)
})

test('offline missing reranker fails without attempting model/tokenizer downloads', async (t) => {
  const { run, calls } = await fixture(t)
  const result = await run(['--offline', 'search_docs', 'entity'], {
    CDS_MCP_TEST_NO_NETWORK: 'true',
    RERANK_ENABLED: 'true'
  })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /cds-mcp --download/)
  const events = await calls()
  assert.equal(
    events.filter(({ kind }) => ['fetch', 'install', 'reranker-download'].includes(kind)).length,
    0
  )
  for (const kind of ['tokenizer', 'reranker'])
    assert.equal(events.find((event) => event.kind === kind).options.local_files_only, true)
})

test('environment offline and download conflict before any resource loading', async (t) => {
  const { run, calls } = await fixture(t)
  const result = await run(['--download'], { CDS_MCP_OFFLINE: 'true' })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /incompatible|only argument/)
  assert.deepEqual(await calls(), [])
})

test('offline missing documentation fails with preparation hint and no network requests', async (t) => {
  const { run, calls } = await fixture(t, { docs: false })
  const result = await run(['--offline', 'search_docs', 'entity'], {
    CDS_MCP_TEST_NO_NETWORK: 'true'
  })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /no local embeddings version found/)
  assert.match(result.stderr, /cds-mcp --download/)
  assert.deepEqual(await calls(), [])
})

for (const invalid of [
  'invalid JSON',
  'null',
  JSON.stringify({ dim: 1.5, chunks: ['a', 'b'], model: defaultModel }),
  JSON.stringify({ dim: 2, chunks: ['a', 'b'], model: '  ' })
]) {
  test(`offline corrupt documentation (${invalid}) is preserved without repair requests`, async (t) => {
    const { cache, run, calls } = await fixture(t)
    const metaPath = path.join(
      cache,
      'embeddings',
      defaultModel.replaceAll('/', '--'),
      'fixture',
      'code-chunks.json'
    )
    await fs.writeFile(metaPath, invalid)
    const binPath = path.join(path.dirname(metaPath), 'code-chunks.bin')
    if (invalid.includes('1.5'))
      await fs.writeFile(binPath, Buffer.from(new Float32Array([1, 2, 3]).buffer))
    const binary = await fs.readFile(binPath)
    const etagPath = await seedManifest(cache)
    const manifest = await fs.readFile(etagPath, 'utf8')
    const result = await run(['--offline', 'search_docs', 'entity'], {
      CDS_MCP_TEST_NO_NETWORK: 'true'
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Corrupted files/)
    assert.match(result.stderr, /cds-mcp --download/)
    assert.equal(await fs.readFile(metaPath, 'utf8'), invalid)
    assert.deepEqual(await fs.readFile(binPath), binary)
    assert.equal(await fs.readFile(etagPath, 'utf8'), manifest)
    assert.deepEqual(await calls(), [])
  })
}

test('help and version do not fetch or load models', async (t) => {
  const { run, calls } = await fixture(t, { docs: false, queryModel: null })
  for (const flag of ['--help', '--version']) {
    const result = await run([flag], { CDS_MCP_TEST_NO_NETWORK: 'true' })
    assert.equal(result.code, 0, result.stderr)
  }
  assert.deepEqual(await calls(), [])
})

for (const flag of ['cli', 'env']) {
  test(`${flag} custom model selection is used for preparation`, async (t) => {
    const { run, calls } = await fixture(t, { docs: false, queryModel: null })
    const args = flag === 'cli' ? ['--model', 'test/custom', '--download'] : ['--download']
    const result = await run(args, flag === 'env' ? { CDS_MCP_MODEL: 'test/custom' } : {})
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).model, 'test/custom')
    assert.deepEqual(
      (await calls()).filter(({ kind }) => kind === 'install').map(({ model }) => model),
      ['test/custom']
    )
  })
}
