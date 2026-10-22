import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolveEmbeddingModel } from '@cap-js/ai/lib/vector_embedding/embedding.js'
import { readModelLock, verifyModelDirectory } from '@cap-js/ai/lib/vector_embedding/model-utils.js'
import { resolveModelCache, MODEL_CACHE_DIR, LOCAL_MODEL_CACHE_DIR } from '../lib/modelCache.js'

const model = 'BAAI/bge-small-en-v1.5'
const localRoot = path.join(os.tmpdir(), 'mcp-package', '.cds', 'models')
const home = path.join(os.tmpdir(), 'mcp-user')
const missing = () => {
  throw Object.assign(new Error('missing'), { code: 'ENOENT' })
}

describe('embedding model cache', () => {
  test('released AI installs and repairs only home, reuses it, and validates local overrides', async (t) => {
    const temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-model-cache-'))
    )
    t.after(() => fs.rm(temporary, { recursive: true, force: true }))
    const localRoot = path.join(temporary, 'package', '.cds', 'models')
    const home = path.join(temporary, 'home')
    const homeRoot = path.join(home, '.cds', 'models')
    const homeDir = path.join(homeRoot, ...model.split('/'))
    const localDir = path.join(localRoot, ...model.split('/'))
    const artifacts = new Map([
      ['model.onnx', Buffer.from('mock model bytes')],
      ['tokenizer.json', Buffer.from('{"mock":"tokenizer"}')],
      ['tokenizer_config.json', Buffer.from('{"mock":"configuration"}')]
    ])
    const descriptor = {
      repository: model,
      revision: 'a'.repeat(40),
      dimensions: 3,
      maxLength: 32,
      output: { name: 'last_hidden_state', pooling: 'mean', normalize: true, includePrompt: true },
      files: [...artifacts].map(([name, bytes], index) => ({
        role: ['model', 'tokenizer', 'tokenizerConfig'][index],
        name,
        path: name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }))
    }
    let discoveries = 0
    let downloads = 0
    let validations = 0
    const resolve = (configuration, options) =>
      resolveEmbeddingModel(configuration, {
        ...options,
        warn: () => {},
        discover: async (repository) => {
          discoveries++
          assert.equal(repository, model)
          return descriptor
        },
        fetchImpl: async (url) => {
          downloads++
          const bytes = artifacts.get(new URL(url).pathname.split('/').at(-1))
          assert.ok(bytes, 'only descriptor artifacts may be fetched')
          return new Response(bytes)
        },
        validate: async (directory) => {
          validations++
          assert.ok(directory.startsWith(home))
          await verifyModelDirectory(directory, descriptor)
        }
      })
    const options = { localRoot, home, resolve }
    assert.equal(await resolveModelCache(model, options), homeRoot)
    assert.equal(discoveries, 1)
    assert.equal(downloads, artifacts.size)
    assert.equal(validations, 1)
    assert.deepEqual(await readModelLock(homeDir), descriptor)
    await verifyModelDirectory(homeDir, descriptor)
    await assert.rejects(fs.lstat(path.join(temporary, 'package', '.cds')), { code: 'ENOENT' })

    assert.equal(await resolveModelCache(model, options), homeRoot)
    assert.equal(downloads, artifacts.size)
    assert.equal(discoveries, 1)

    // A valid lock lets the installer repair damaged artifacts without rediscovering the model.
    await fs.writeFile(path.join(homeDir, 'model.onnx'), 'damaged')
    assert.equal(await resolveModelCache(model, options), homeRoot)
    assert.equal(discoveries, 1)
    assert.equal(downloads, artifacts.size * 2)
    await verifyModelDirectory(homeDir, descriptor)
    await assert.rejects(fs.lstat(path.join(temporary, 'package', '.cds')), { code: 'ENOENT' })

    await fs.mkdir(path.dirname(localDir), { recursive: true })
    await fs.cp(homeDir, localDir, { recursive: true })
    // An unusable home lock proves the local override wins before any home lookup.
    await fs.writeFile(path.join(homeDir, 'embedding.lock.json'), '{}')
    assert.equal(await resolveModelCache(model, options), localRoot)
    assert.equal(downloads, artifacts.size * 2)
    assert.equal(discoveries, 1)

    await fs.writeFile(path.join(localDir, 'model.onnx'), 'damaged')
    await assert.rejects(resolveModelCache(model, options), /failed integrity checks/)
    assert.equal(await fs.readFile(path.join(localDir, 'model.onnx'), 'utf8'), 'damaged')
    assert.equal(downloads, artifacts.size * 2)
    await fs.unlink(path.join(localDir, 'embedding.lock.json'))
    await assert.rejects(resolveModelCache(model, options), /Embedding model lock not found/)
    assert.equal(downloads, artifacts.size * 2)
  })

  test('default paths are package-local and user-home, not caller-local', () => {
    assert.equal(MODEL_CACHE_DIR, path.join(os.homedir(), '.cds', 'models'))
    assert.equal(LOCAL_MODEL_CACHE_DIR, fileURLToPath(new URL('../.cds/models', import.meta.url)))
  })

  test('existing package-local model takes precedence and uses the read-only resolver', async () => {
    const calls = []
    const selected = await resolveModelCache(model, {
      localRoot,
      home,
      lstat: async (directory) =>
        assert.equal(directory, path.join(localRoot, ...model.split('/'))),
      resolve: async (...args) => calls.push(args)
    })
    assert.equal(selected, localRoot)
    assert.deepEqual(calls, [[{ model, directory: localRoot }]])
  })

  test('missing local model delegates home lookup, installation and repair to the implicit resolver', async () => {
    const calls = []
    const selected = await resolveModelCache(model, {
      localRoot,
      home,
      lstat: missing,
      resolve: async (...args) => calls.push(args)
    })
    assert.equal(selected, path.join(home, '.cds', 'models'))
    assert.deepEqual(calls, [[{ model }, { root: home, home }]])
  })

  for (const reason of [
    'missing lock',
    'invalid lock',
    'repository mismatch',
    'damaged artifacts',
    'symlink'
  ]) {
    test(`local ${reason} fails without falling back or provisioning`, async () => {
      const failure = new Error(reason)
      let calls = 0
      await assert.rejects(
        resolveModelCache(model, {
          localRoot,
          home,
          lstat: async () => ({}),
          resolve: async (configuration) => {
            calls++
            assert.equal(configuration.directory, localRoot)
            throw failure
          }
        }),
        (error) => error === failure
      )
      assert.equal(calls, 1)
    })
  }

  test('local inspection errors do not silently fall back to home', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    await assert.rejects(
      resolveModelCache(model, {
        localRoot,
        home,
        lstat: async () => {
          throw failure
        },
        resolve: async () => assert.fail('must not resolve another cache')
      }),
      (error) => error === failure
    )
  })

  test('home validation and provisioning failures propagate', async () => {
    const failure = new Error('invalid home lock')
    await assert.rejects(
      resolveModelCache(model, {
        localRoot,
        home,
        lstat: missing,
        resolve: async () => {
          throw failure
        }
      }),
      (error) => error === failure
    )
  })

  test('unsafe model names fail before inspecting or provisioning paths', async () => {
    await assert.rejects(
      resolveModelCache('../escape', {
        localRoot,
        home,
        lstat: async () => assert.fail('must not inspect unsafe path'),
        resolve: async () => assert.fail('must not provision unsafe path')
      })
    )
  })
})
