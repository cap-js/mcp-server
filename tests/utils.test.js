import { test } from 'node:test'
import assert from 'node:assert'
import {
  configuredBoolean,
  configuredNonEmptyString,
  configuredPositiveInteger
} from '../lib/utils.js'

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
