import { test, describe, before, beforeEach, after, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import fsp from 'node:fs/promises'
import path from 'path'
import os from 'node:os'
import { getEmbeddings, createEmbeddings, hybridSearch } from '../lib/embeddings.js'
import calculateEmbeddings, {
  getQueryDb,
  getActiveEmbeddingsDir,
  setEmbeddingsDir,
  getActiveModel,
  MODEL_CACHE_ROOT
} from '../lib/calculateEmbeddings.js'
import cds from '@sap/cds'

const REQUIRED_FILES = ['model.onnx', 'tokenizer.json', 'tokenizer_config.json']

describe('embeddings', () => {
  afterEach(() => mock.restoreAll())

  test('getEmbeddings returns a non-empty array for a plain string', async () => {
    const results = await getEmbeddings('Node.js testing')
    assert(results.length > 0, 'getEmbeddings result should be non-empty')
  })

  describe('model setup', () => {
    let MODEL_DIR
    before(async () => {
      await getQueryDb()
      const modelPath = getActiveModel().split('/')
      const localDir = path.join(MODEL_CACHE_ROOT, '.cds', 'models', ...modelPath)
      MODEL_DIR = fs.existsSync(localDir)
        ? localDir
        : path.join(os.homedir(), '.cds', 'models', ...modelPath)
    })
    test('model directory and required files exist and are non-empty', async () => {
      assert(fs.existsSync(MODEL_DIR), 'Model directory should exist after initialization')

      for (const file of REQUIRED_FILES) {
        const filePath = path.join(MODEL_DIR, file)
        assert(fs.existsSync(filePath), `Required model file ${file} should exist`)

        const stats = fs.statSync(filePath)
        assert(stats.size > 0, `Model file ${file} should not be empty`)
      }
    })

    test('tokenizer.json has vocab and model.onnx is larger than 1 MB', async () => {
      const tokenizerPath = path.join(MODEL_DIR, 'tokenizer.json')
      const tokenizerData = JSON.parse(fs.readFileSync(tokenizerPath, 'utf-8'))

      assert(typeof tokenizerData === 'object', 'Tokenizer should be a valid JSON object')
      assert(tokenizerData.model, 'Tokenizer should have model property')
      assert(tokenizerData.model.vocab, 'Tokenizer should have vocab property')
      assert(typeof tokenizerData.model.vocab === 'object', 'Vocab should be an object')

      const configPath = path.join(MODEL_DIR, 'tokenizer_config.json')
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      assert(typeof configData === 'object', 'Tokenizer config should be a valid JSON object')

      const modelPath = path.join(MODEL_DIR, 'model.onnx')
      const modelStats = fs.statSync(modelPath)
      assert(modelStats.size > 1000000, 'ONNX model file should be reasonably large (>1MB)')
    })

    test('model cache is independent of the caller project', async () => {
      const db = await getQueryDb()
      assert.strictEqual(db.options.embedding.root, MODEL_CACHE_ROOT)
      assert.strictEqual(db.options.embedding.directory, undefined)
      const prevRoot = cds.root
      const callerProject = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-caller-'))
      cds.root = callerProject
      try {
        const result = await calculateEmbeddings('test query')
        assert.ok(result instanceof Float32Array, 'result must be a Float32Array')
        assert.ok(result.length > 0, 'embedding must be non-empty')
        const entries = await fsp.readdir(MODEL_DIR)
        assert.ok(entries.includes('embedding.lock.json'), `expected model files in ${MODEL_DIR}`)
        assert.strictEqual(cds.root, callerProject)
        const strayDir = path.join(callerProject, '.cds', 'models')
        assert.ok(
          !fs.existsSync(strayDir),
          `model must not be created under cds.root (${strayDir})`
        )
      } finally {
        cds.root = prevRoot
        await fsp.rm(callerProject, { recursive: true, force: true })
      }
    })
  })

  describe('calculateEmbeddings', () => {
    test('returns a 384-dimensional normalized float vector', async () => {
      const testString = 'This is a test string for embedding verification'
      const calculateEmbeddingsResult = await calculateEmbeddings(testString)

      assert(
        Array.isArray(calculateEmbeddingsResult) ||
          calculateEmbeddingsResult instanceof Float32Array,
        'calculateEmbeddings should return an array'
      )
      assert(
        calculateEmbeddingsResult.every((val) => typeof val === 'number'),
        'calculateEmbeddings should return numeric values'
      )

      const hiddenSize = 384
      assert.strictEqual(
        calculateEmbeddingsResult.length,
        hiddenSize,
        'calculateEmbeddings should return embedding of size 384'
      )

      let norm = 0
      for (let i = 0; i < hiddenSize; i++)
        norm += calculateEmbeddingsResult[i] * calculateEmbeddingsResult[i]
      norm = Math.sqrt(norm)
      assert(
        Math.abs(norm - 1.0) < 0.001,
        `calculateEmbeddings should be normalized (norm ≈ 1.0), got ${norm}`
      )
    })

    test('produces consistent embeddings for identical inputs', async () => {
      const testString = 'Consistent embedding test string'
      const embedding1 = await calculateEmbeddings(testString)
      const embedding2 = await calculateEmbeddings(testString)

      assert.strictEqual(embedding1.length, embedding2.length, 'Embeddings should have same length')
      for (let i = 0; i < embedding1.length; i++) {
        const diff = Math.abs(embedding1[i] - embedding2[i])
        assert(
          diff < 0.0001,
          `Embedding values should be consistent at index ${i}: ${embedding1[i]} vs ${embedding2[i]}`
        )
      }
    })

    test('produces different embeddings for semantically distinct inputs', async () => {
      const embedding1 = await calculateEmbeddings('First test string')
      const embedding2 = await calculateEmbeddings('Completely different sentence')

      assert.strictEqual(embedding1.length, embedding2.length, 'Embeddings should have same length')

      let dotProduct = 0,
        norm1 = 0,
        norm2 = 0
      for (let i = 0; i < embedding1.length; i++) {
        dotProduct += embedding1[i] * embedding2[i]
        norm1 += embedding1[i] * embedding1[i]
        norm2 += embedding2[i] * embedding2[i]
      }
      const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2))
      assert(
        similarity < 0.99,
        `Different strings should produce different embeddings, similarity: ${similarity}`
      )
      assert(
        similarity > -1.0 && similarity < 1.0,
        `Similarity should be in valid range [-1, 1]: ${similarity}`
      )
    })

    test('handles empty string without throwing or returning non-finite values', async () => {
      try {
        const embedding = await calculateEmbeddings('')
        assert.strictEqual(
          embedding.length,
          384,
          'Empty string should still return 384-dimensional embedding'
        )
        assert(
          embedding.every((val) => typeof val === 'number' && isFinite(val)),
          'Empty string embedding should contain valid finite numbers'
        )
      } catch (error) {
        assert(error instanceof Error, 'Should throw a proper Error for empty strings')
      }
    })

    test('long string returns a 384-dimensional normalized embedding', async () => {
      const longString = 'This is a moderately long test string. '.repeat(10)
      const embedding = await calculateEmbeddings(longString)

      assert.strictEqual(
        embedding.length,
        384,
        'Long string should still return 384-dimensional embedding'
      )

      let norm = 0
      for (let i = 0; i < embedding.length; i++) norm += embedding[i] * embedding[i]
      norm = Math.sqrt(norm)
      assert(Math.abs(norm - 1.0) < 0.001, `Long string embedding should be normalized: ${norm}`)
    })

    test('explicit model returns different dimensions than default', async () => {
      const MODEL = 'nomic-ai/nomic-embed-text-v1.5'
      const text = 'test query for model param'
      const withoutModel = await calculateEmbeddings(text)
      const withModel = await calculateEmbeddings(text, MODEL)
      assert.notStrictEqual(
        withModel.length,
        withoutModel.length,
        'explicit model must return different dim than default'
      )
    })

    test('reuses cache when called twice with same model', async () => {
      const MODEL = 'nomic-ai/nomic-embed-text-v1.5'
      const text = 'cache reuse test'
      await calculateEmbeddings(text, MODEL)
      const dbBefore = await getQueryDb(MODEL)
      dbBefore.cached = true
      await calculateEmbeddings(text, MODEL)
      const dbAfter = await getQueryDb(MODEL)
      assert.ok(dbAfter.cached, 'repeated call with same model must succeed')
    })

    test('undefined model falls back to default', async () => {
      const result = await calculateEmbeddings('no model param test', undefined)
      assert.strictEqual(result.length, 384, 'undefined model must use default and return 384-dim')
    })
  })

  // createEmbeddings tests — fs writes go to a dedicated tmp dir; no real embeddings dir touched.
  describe('createEmbeddings', () => {
    let tmpDir

    before(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'embeddings-'))
      setEmbeddingsDir(tmpDir)
    })

    beforeEach(async () => {
      const dir = getActiveEmbeddingsDir()
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      await fsp.mkdir(dir, { recursive: true })
    })

    after(async () => {
      setEmbeddingsDir()
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    })

    test('createEmbeddings preserves chunk order in output', async () => {
      const chunks = [
        'first chunk about cds init',
        'second chunk about cds watch',
        'third chunk about cds deploy',
        'fourth chunk about service definitions',
        'fifth chunk about entity projections'
      ]
      const { outDir } = await createEmbeddings('test', chunks, chunks)
      const meta = JSON.parse(await fsp.readFile(path.join(outDir, 'test.json'), 'utf-8'))
      assert.deepStrictEqual(meta.chunks, chunks, 'output chunks must match input order exactly')
    })

    test('createEmbeddings writes canonicalChunks when provided', async () => {
      const chunks = ['context\n\nfirst canonical chunk', 'context\n\nsecond canonical chunk']
      const canonicalChunks = ['first canonical chunk', 'second canonical chunk']
      const { outDir } = await createEmbeddings('test', chunks, canonicalChunks)
      const meta = JSON.parse(await fsp.readFile(path.join(outDir, 'test.json'), 'utf-8'))

      assert.deepStrictEqual(meta.chunks, canonicalChunks)
    })

    test('createEmbeddings writes metadata when provided', async () => {
      const chunks = ['chunk about cds init', 'chunk about cds watch', 'chunk about cds deploy']
      const metadata = [
        { source: 'getting-started', label: 'node' },
        { source: 'getting-started', label: 'java' },
        { source: 'deploy', label: 'node' }
      ]
      const { outDir } = await createEmbeddings('test', chunks, chunks, { metadata })
      const meta = JSON.parse(await fsp.readFile(path.join(outDir, 'test.json'), 'utf-8'))
      assert.deepStrictEqual(meta.metadata, metadata, 'metadata must be written as-is')
      assert.deepStrictEqual(meta.chunks, chunks, 'chunks must still be present alongside metadata')
    })

    test('createEmbeddings without metadata produces no metadata key', async () => {
      const chunks = ['chunk about cds init']
      const { outDir } = await createEmbeddings('test', chunks, chunks)
      const meta = JSON.parse(await fsp.readFile(path.join(outDir, 'test.json'), 'utf-8'))
      assert.strictEqual(meta.metadata, undefined, 'metadata key must be absent when not provided')
    })
    test('createEmbeddings places output under capire.version folder', async () => {
      const chunks = ['chunk about cds init']
      const capire = {
        commitId: '__commit_id_1234__',
        cdsDependency: { node: '>=10.0', java: '>=5.0' }
      }
      const { outDir } = await createEmbeddings('test', chunks, chunks, { capire })
      assert.ok(
        outDir.endsWith('__commit_id_1234__'),
        `outDir should end with version folder, got: ${outDir}`
      )
      const meta = JSON.parse(await fsp.readFile(path.join(outDir, 'test.json'), 'utf-8'))
      assert.deepStrictEqual(meta.capire, capire)
    })

    test('createEmbeddings without capire uses model folder only', async () => {
      const chunks = ['chunk about cds init']
      const { outDir, modelFolderName } = await createEmbeddings('test', chunks, chunks)
      const meta = JSON.parse(await fsp.readFile(path.join(outDir, 'test.json'), 'utf-8'))
      assert.strictEqual(meta.capire, undefined)
      assert.ok(
        outDir.endsWith(modelFolderName),
        `outDir should end with ${modelFolderName}, got: ${outDir}`
      )
    })

    test('createEmbeddings throws when metadata length mismatches chunks', async () => {
      await assert.rejects(
        () =>
          createEmbeddings('test', ['a', 'b', 'c'], undefined, {
            metadata: [{ x: 1 }, { x: 2 }]
          }),
        /metadata length must match chunks length/
      )
    })

    test('createEmbeddings writes a valid ISO 8601 createdAt timestamp', async () => {
      const before = new Date()
      const chunks = ['chunk about cds init']
      const { outDir } = await createEmbeddings('test', chunks, chunks)
      const after = new Date()
      const meta = JSON.parse(await fsp.readFile(path.join(outDir, 'test.json'), 'utf-8'))
      assert.ok(typeof meta.createdAt === 'string', 'createdAt must be a string')
      const ts = new Date(meta.createdAt)
      assert.ok(!isNaN(ts.getTime()), 'createdAt must parse to a valid date')
      assert.strictEqual(
        meta.createdAt,
        ts.toISOString(),
        'createdAt must use canonical ISO 8601 format'
      )
      assert.ok(
        ts >= before && ts <= after,
        `createdAt must be between test start and end, got: ${meta.createdAt}`
      )
    })
  })

  describe('hybridSearch runtime filter', () => {
    // Build chunks with real embeddings so cosine and BM25 both run.
    async function buildChunks() {
      const specs = [
        { content: 'Write custom handlers in Java with the CAP runtime', meta: { label: 'java' } },
        {
          content: 'Write custom handlers in Node.js with the CAP runtime',
          meta: { label: 'node' }
        },
        { content: 'Deploy the service to the cloud', meta: { source: 'deploy' } },
        { content: 'Model your domain with CDS entities' }
      ]
      const chunks = []
      for (const spec of specs) {
        const embeddings = await getEmbeddings(spec.content)
        const entry = { content: spec.content, embeddings }
        if (spec.meta) entry.meta = spec.meta
        chunks.push(entry)
      }
      return chunks
    }

    describe('when a runtime is given', () => {
      test('should keep java and unlabeled chunks and drop node chunks when runtime is java', async () => {
        const chunks = await buildChunks()

        const results = await hybridSearch('custom handlers', chunks, { runtime: 'java' })

        const labels = results.map((r) => r.meta?.label)
        assert.ok(!labels.includes('node'), 'node-labeled chunks must be dropped')
        assert.ok(labels.includes('java'), 'java-labeled chunk must stay')
        assert.strictEqual(results.length, 3, 'java + two unlabeled chunks must stay')
      })

      test('should keep node and unlabeled chunks and drop java chunks when runtime is node', async () => {
        const chunks = await buildChunks()

        const results = await hybridSearch('custom handlers', chunks, { runtime: 'node' })

        const labels = results.map((r) => r.meta?.label)
        assert.ok(!labels.includes('java'), 'java-labeled chunks must be dropped')
        assert.ok(labels.includes('node'), 'node-labeled chunk must stay')
        assert.strictEqual(results.length, 3, 'node + two unlabeled chunks must stay')
      })

      test('should keep all chunks when none carry the other runtime label', async () => {
        const chunks = (await buildChunks()).filter((c) => c.meta?.label !== 'node')

        const results = await hybridSearch('custom handlers', chunks, { runtime: 'java' })

        assert.strictEqual(results.length, chunks.length, 'java and unlabeled chunks must all stay')
      })

      test('should read chunks.model for the query embedding before filtering', async () => {
        const chunks = await buildChunks()
        chunks.model = getActiveModel()

        // The filter must not drop chunks.model; a wrong model throws on dim mismatch.
        const results = await hybridSearch('custom handlers', chunks, { runtime: 'java' })

        assert.ok(results.length > 0, 'search must return results with the chunk model')
      })
    })

    describe('when no runtime is given', () => {
      test('should keep every chunk', async () => {
        const chunks = await buildChunks()

        const results = await hybridSearch('custom handlers', chunks)

        const labels = results.map((r) => r.meta?.label)
        assert.strictEqual(results.length, 4, 'all chunks must stay when runtime is not set')
        assert.ok(labels.includes('node') && labels.includes('java'), 'both runtimes must stay')
      })
    })

    describe('side-effects', () => {
      test('should not mutate the input chunks array or its objects', async () => {
        const chunks = await buildChunks()
        const lengthBefore = chunks.length
        const keysBefore = chunks.map((c) => Object.keys(c).sort().join(','))

        await hybridSearch('custom handlers', chunks, { runtime: 'java' })

        assert.strictEqual(chunks.length, lengthBefore, 'input length must not change')
        assert.deepStrictEqual(
          chunks.map((c) => Object.keys(c).sort().join(',')),
          keysBefore,
          'input chunk keys must not change'
        )
        assert.ok(
          chunks.every((c) => c.similarity === undefined),
          'similarity must not leak onto input chunks'
        )
      })

      test('should return new objects rather than the input chunk references', async () => {
        const chunks = await buildChunks()

        const results = await hybridSearch('custom handlers', chunks, { runtime: 'java' })

        assert.ok(
          results.every((r) => !chunks.includes(r)),
          'results must be copies, not input references'
        )
      })
    })
  })
})
