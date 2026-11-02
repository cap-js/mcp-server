import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as api from '@cap-js/mcp-server'

const exec = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))

describe('public JavaScript API', () => {
  it('should expose the supported generation and chunking API at the package root', () => {
    assert.deepEqual(Object.keys(api).sort(), [
      'DEFAULT_MODEL',
      'createMarkdownEmbeddings',
      'runPipeline'
    ])
    assert.equal(api.DEFAULT_MODEL, 'BAAI/bge-small-en-v1.5')
    assert.equal(typeof api.createMarkdownEmbeddings, 'function')
    assert.equal(typeof api.runPipeline, 'function')
  })

  it('should import from a consumer without running the CLI, opening connections or writing files', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-api-consumer-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const scope = join(root, 'node_modules', '@cap-js')
    await mkdir(scope, { recursive: true })
    await symlink(packageRoot, join(scope, 'mcp-server'), 'junction')
    const filesBefore = await readdir(root, { recursive: true })
    const script = `
      import assert from 'node:assert/strict'
      import { mock } from 'node:test'
      import { Socket, Server } from 'node:net'

      process.argv = [process.execPath, 'consumer.js', '--model', 'host/model', '--host-option']
      const argv = [...process.argv]
      const emitWarning = process.emitWarning
      const unexpected = () => { throw new Error('Unexpected import side effect') }
      const fetch = mock.method(globalThis, 'fetch', unexpected)
      const connect = mock.method(Socket.prototype, 'connect', unexpected)
      const listen = mock.method(Server.prototype, 'listen', unexpected)
      const exit = mock.method(process, 'exit', unexpected)
      try {
        const { createMarkdownEmbeddings, DEFAULT_MODEL, runPipeline } = await import('@cap-js/mcp-server')

        assert.equal(typeof createMarkdownEmbeddings, 'function')
        assert.equal(typeof runPipeline, 'function')
        assert.equal(DEFAULT_MODEL, 'BAAI/bge-small-en-v1.5')
        assert.equal(process.env.CDS_MCP_MODEL, 'fixture/selected-model')
        assert.deepEqual(process.argv, argv)
        assert.equal(process.emitWarning, emitWarning)
        for (const method of [fetch, connect, listen, exit])
          assert.equal(method.mock.callCount(), 0)
      } finally {
        mock.restoreAll()
      }
    `

    const { stdout, stderr } = await exec(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        cwd: root,
        env: { ...process.env, CDS_MCP_MODEL: 'fixture/selected-model' },
        timeout: 10000
      }
    )

    assert.equal(stdout, '')
    assert.equal(stderr, '')
    assert.deepEqual(await readdir(root, { recursive: true }), filesBefore)
  })

  it('should reject imports of private implementation paths', async () => {
    await assert.rejects(import('@cap-js/mcp-server/lib/calculateEmbeddings.js'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    })
  })
})
