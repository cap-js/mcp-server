import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as api from '@cap-js/mcp-server'

describe('public JavaScript API', () => {
  it('should expose only the generator and default model at the package root', () => {
    assert.deepEqual(Object.keys(api).sort(), ['DEFAULT_MODEL', 'createMarkdownEmbeddings'])
    assert.equal(api.DEFAULT_MODEL, 'BAAI/bge-small-en-v1.5')
    assert.equal(typeof api.createMarkdownEmbeddings, 'function')
  })

  it('should reject imports of private implementation paths', async () => {
    await assert.rejects(import('@cap-js/mcp-server/lib/calculateEmbeddings.js'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    })
  })
})
