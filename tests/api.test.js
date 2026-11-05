import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as api from '@cap-js/mcp-server'

const exec = promisify(execFile)

describe('public JavaScript API', () => {
  it('should expose only the generator and default model at the package root', () => {
    assert.deepEqual(Object.keys(api).sort(), ['DEFAULT_MODEL', 'createMarkdownEmbeddings'])
    assert.equal(api.DEFAULT_MODEL, 'BAAI/bge-small-en-v1.5')
    assert.equal(typeof api.createMarkdownEmbeddings, 'function')
  })

  it('should dynamically import from CommonJS without loading CDS or starting the CLI', async () => {
    const script = `
      const assert = require('node:assert/strict')
      ;(async () => {
        try {
          const api = await import('@cap-js/mcp-server')
          assert.equal(api.DEFAULT_MODEL, 'BAAI/bge-small-en-v1.5')
          assert.equal(typeof api.createMarkdownEmbeddings, 'function')
          assert.equal(Object.keys(require.cache).some(path => path.includes('/@sap/cds/')), false)
          console.log('API imported without CDS')
        } catch (error) {
          console.error(error)
          process.exitCode = 1
        }
      })()
    `

    const { stdout, stderr } = await exec(process.execPath, ['--input-type=commonjs', '-e', script])

    assert.equal(stdout.trim(), 'API imported without CDS')
    assert.equal(stderr, '')
  })

  it('should reject imports of private implementation paths', async () => {
    await assert.rejects(import('@cap-js/mcp-server/lib/calculateEmbeddings.js'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    })
  })
})
