import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { after, test } from 'node:test'

process.env.CDS_MCP_OFFLINE = 'true'
const moduleCacheDir = await mkdtemp(path.join(tmpdir(), 'cds-mcp-module-cache-'))
process.env.CDS_MCP_CACHE_DIR = moduleCacheDir

const { MODEL_ARTIFACTS, MODEL_REVISION, downloadFile, ensureModelArtifacts, readVerifiedFile, verifyFile } =
  await import('../lib/calculateEmbeddings.js')

after(() => rm(moduleCacheDir, { recursive: true, force: true }))

const sha256 = value => createHash('sha256').update(value).digest('hex')

test('model downloads use an immutable revision and declared SHA-256 digests', () => {
  assert.match(MODEL_REVISION, /^[0-9a-f]{40}$/)

  for (const artifact of MODEL_ARTIFACTS) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/)
    assert(artifact.url.includes(`/resolve/${MODEL_REVISION}/`))
    assert(!artifact.url.includes('/resolve/main/'))
  }
})

test('downloadFile verifies content before atomically replacing a file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-mcp-download-'))
  const outputPath = path.join(dir, 'tokenizer.json')
  const downloaded = '{"model":{"vocab":{"a":1}}}'

  try {
    await writeFile(outputPath, 'previous trusted content')

    await downloadFile(
      'https://example.invalid/tokenizer.json',
      outputPath,
      sha256(downloaded),
      async () => new Response(downloaded, { status: 200 })
    )

    assert.equal(await readFile(outputPath, 'utf8'), downloaded)
    assert.deepEqual(await readdir(dir), ['tokenizer.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('downloadFile rejects a digest mismatch without replacing the existing file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-mcp-download-'))
  const outputPath = path.join(dir, 'model.onnx')

  try {
    await writeFile(outputPath, 'previous trusted content')

    await assert.rejects(
      downloadFile(
        'https://example.invalid/model.onnx',
        outputPath,
        sha256('expected content'),
        async () => new Response('unexpected content', { status: 200 })
      ),
      /integrity check failed/i
    )

    assert.equal(await readFile(outputPath, 'utf8'), 'previous trusted content')
    assert.deepEqual(await readdir(dir), ['model.onnx'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('verifyFile rejects untrusted cached artifacts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-mcp-download-'))
  const outputPath = path.join(dir, 'model.onnx')

  try {
    await writeFile(outputPath, 'tampered')
    await assert.rejects(verifyFile(outputPath, sha256('trusted')), /integrity check failed/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readVerifiedFile returns the same bytes that passed verification', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-mcp-download-'))
  const outputPath = path.join(dir, 'model.onnx')
  const trusted = Buffer.from('trusted model bytes')

  try {
    await writeFile(outputPath, trusted)
    const verified = await readVerifiedFile(outputPath, sha256(trusted))
    assert.deepEqual(verified, trusted)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureModelArtifacts repairs a corrupted cache with verified content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-mcp-download-'))
  const trusted = Buffer.from('trusted model bytes')
  const artifacts = [
    {
      name: 'model.onnx',
      url: 'https://example.invalid/model.onnx',
      sha256: sha256(trusted)
    }
  ]
  let fetches = 0

  try {
    await writeFile(path.join(dir, 'model.onnx'), 'tampered')
    const result = await ensureModelArtifacts({
      directory: dir,
      artifacts,
      offlineMode: false,
      fetchImpl: async () => {
        fetches++
        return new Response(trusted, { status: 200 })
      }
    })

    assert.deepEqual(result, { updated: true })
    assert.equal(fetches, 1)
    assert.deepEqual(await readFile(path.join(dir, 'model.onnx')), trusted)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureModelArtifacts fails closed offline without fetching', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-mcp-download-'))
  const artifacts = [
    {
      name: 'model.onnx',
      url: 'https://example.invalid/model.onnx',
      sha256: sha256('trusted')
    }
  ]
  let fetched = false

  try {
    await writeFile(path.join(dir, 'model.onnx'), 'tampered')
    await assert.rejects(
      ensureModelArtifacts({
        directory: dir,
        artifacts,
        offlineMode: true,
        fetchImpl: async () => {
          fetched = true
          return new Response('trusted', { status: 200 })
        }
      }),
      /integrity check failed/i
    )
    assert.equal(fetched, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
