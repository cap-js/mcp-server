import assert from 'node:assert/strict'
import { realpath, lstat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, describe } from 'node:test'
import { createMcpProjectPathResolver, resolvePathsWithinRoots, resolveProjectPath } from '../lib/projectPath.js'

// Committed fixture — the test reads it and exercises the REAL realpath/symlink
// behaviour. It creates, edits, or removes nothing at runtime.
//
//   project-path/
//     workspace/              a workspace root
//       project/              a valid project inside the root
//       linked-project -> ../escapes   symlink that escapes the root
//     workspace-secret/       sibling with a shared "workspace" prefix
//     escapes/                dir outside the root (the symlink target)
//     private-model.cds       file outside the root
const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, 'fixtures', 'project-path')
const workspace = join(fixtures, 'workspace')
const project = join(workspace, 'project')
const sibling = join(fixtures, 'workspace-secret')
const escapingLink = join(workspace, 'linked-project')
const outsideFile = join(fixtures, 'private-model.cds')

describe('project path authorization', () => {
  test('accepts projects inside a canonical workspace root', async () => {
    assert.equal(await resolveProjectPath(project, [workspace]), await realpath(project))
  })

  test('rejects paths outside roots and sibling paths with a shared prefix', async () => {
    await assert.rejects(resolveProjectPath(sibling, [workspace]), /outside the configured workspace roots/)
  })

  test('rejects a symlink that escapes a workspace root', async () => {
    // Guard: the fixture must be a real symlink, else realpath() can't escape
    // the root and this test would pass for the wrong reason.
    assert.ok((await lstat(escapingLink)).isSymbolicLink(), `${escapingLink} must be a symlink`)
    await assert.rejects(resolveProjectPath(escapingLink, [workspace]), /outside the configured workspace roots/)
  })

  test('does not expose rejected source paths in workspace errors', async () => {
    await assert.rejects(resolvePathsWithinRoots([outsideFile], [workspace]), error => {
      assert.match(error.message, /outside the configured workspace roots/)
      assert(!error.message.includes(outsideFile))
      return true
    })
  })

  test('uses MCP file roots when the client advertises them', async () => {
    let requestOptions
    const server = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async (_params, options) => {
        requestOptions = options
        return { roots: [{ uri: pathToFileURL(workspace).href }] }
      }
    }

    const resolver = createMcpProjectPathResolver(server, { fallbackRoot: fixtures, timeout: 123 })
    assert.equal((await resolver(project)).projectPath, await realpath(project))
    assert.deepEqual(requestOptions, { timeout: 123, maxTotalTimeout: 123 })
    await assert.rejects(resolver(fixtures), /outside the configured workspace roots/)
  })

  test('falls back to the server working directory for clients without roots support', async () => {
    const server = { getClientCapabilities: () => ({}) }

    const resolver = createMcpProjectPathResolver(server, { fallbackRoot: workspace })
    assert.equal((await resolver(project)).projectPath, await realpath(project))
  })

  test('fails closed when MCP roots cannot be obtained', async () => {
    const server = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => {
        throw new Error('client unavailable')
      }
    }

    const resolver = createMcpProjectPathResolver(server, { fallbackRoot: fixtures })
    await assert.rejects(resolver(fixtures), error => {
      assert.equal(error.message, 'Unable to determine MCP workspace roots')
      assert.equal(error.cause.message, 'client unavailable')
      return true
    })
  })

  test('fails closed with a specific error when all advertised roots are invalid', async () => {
    const server = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({ roots: [{ uri: pathToFileURL(join(fixtures, 'missing')).href }] })
    }

    const resolver = createMcpProjectPathResolver(server, { fallbackRoot: fixtures })
    await assert.rejects(resolver(project), /No valid workspace roots are configured/)
  })
})
