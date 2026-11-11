import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  configuredBoolean,
  configuredNonEmptyString,
  configuredPositiveInteger,
  embeddingCliOverrides,
  embeddingCliConfig
} from '../lib/utils.js'

test('embedding CLI conversion leaves defaults to the API', async () => {
  assert.deepStrictEqual(await embeddingCliConfig(embeddingCliOverrides({})), {
    chunkingConfig: {},
    embeddingConfig: {}
  })
})

test('embedding CLI conversion reads input and maps flags to API configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-cli-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'input.md')
  const text = '# Guide\n\nDocumentation.'
  await writeFile(input, text)
  const overrides = embeddingCliOverrides({
    input,
    output: join(root, 'chunks.json'),
    model: 'fixture/model',
    'min-tokens': '0',
    'max-heading-depth': '3'
  })
  const original = { ...overrides }

  assert.deepStrictEqual(await embeddingCliConfig(overrides), {
    chunkingConfig: { text, minTokens: 0, maxHeadingDepth: 3 },
    embeddingConfig: { model: 'fixture/model', dir: root }
  })
  assert.deepStrictEqual(overrides, original)
})

function withEnvironment(name, value, callback) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value

  try {
    return callback()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test('configuredBoolean accepts only true and false', () => {
  withEnvironment('TEST_BOOLEAN', undefined, () =>
    assert.strictEqual(configuredBoolean('TEST_BOOLEAN', true), true)
  )
  withEnvironment('TEST_BOOLEAN', 'true', () =>
    assert.strictEqual(configuredBoolean('TEST_BOOLEAN'), true)
  )
  withEnvironment('TEST_BOOLEAN', 'false', () =>
    assert.strictEqual(configuredBoolean('TEST_BOOLEAN'), false)
  )
  withEnvironment('TEST_BOOLEAN', 'yes', () =>
    assert.throws(() => configuredBoolean('TEST_BOOLEAN'), /must be true or false/)
  )
})

test('configuredNonEmptyString returns undefined for an unset optional value', () => {
  withEnvironment('TEST_STRING', undefined, () =>
    assert.strictEqual(configuredNonEmptyString('TEST_STRING'), undefined)
  )
})

test('configuredNonEmptyString rejects empty values', () => {
  withEnvironment('TEST_STRING', undefined, () =>
    assert.strictEqual(configuredNonEmptyString('TEST_STRING', 'default'), 'default')
  )
  withEnvironment('TEST_STRING', 'value', () =>
    assert.strictEqual(configuredNonEmptyString('TEST_STRING', 'default'), 'value')
  )
  withEnvironment('TEST_STRING', '   ', () =>
    assert.throws(() => configuredNonEmptyString('TEST_STRING', 'default'), /must not be empty/)
  )
})

test('configuredPositiveInteger enforces integer bounds', () => {
  withEnvironment('TEST_INTEGER', '2', () =>
    assert.strictEqual(configuredPositiveInteger('TEST_INTEGER', 1, { maximum: 3 }), 2)
  )
  for (const value of ['0', '-1', '1.5', 'four', '4']) {
    withEnvironment('TEST_INTEGER', value, () =>
      assert.throws(
        () => configuredPositiveInteger('TEST_INTEGER', 1, { maximum: 3 }),
        /must be a positive integer/
      )
    )
  }
})
