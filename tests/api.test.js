import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRequire } from 'node:module'
import * as api from '@cap-js/mcp-server'

const require = createRequire(import.meta.url)

describe('public JavaScript API', () => {
  it('should expose only the generator and default model at the package root', () => {
    assert.deepEqual(Object.keys(api).sort(), ['DEFAULT_MODEL', 'createCapireEmbeddings'])
    assert.equal(api.DEFAULT_MODEL, 'BAAI/bge-small-en-v1.5')
    assert.equal(typeof api.createCapireEmbeddings, 'function')
  })

  it('should support CommonJS require without loading CDS', () => {
    const commonJSAPI = require('@cap-js/mcp-server')

    assert.equal(commonJSAPI.DEFAULT_MODEL, api.DEFAULT_MODEL)
    assert.equal(commonJSAPI.createCapireEmbeddings, api.createCapireEmbeddings)
    assert.equal(
      Object.keys(require.cache).some((path) => path.includes('/@sap/cds/')),
      false
    )
  })

  it('should reject imports of private implementation paths', async () => {
    await assert.rejects(import('@cap-js/mcp-server/lib/calculateEmbeddings.js'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    })
  })
})
