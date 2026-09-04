import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { createMcpProjectPathResolver, resolveProjectPath } from '../lib/projectPath.js'

test.describe('project path authorization', () => {
  test('accepts projects inside a canonical workspace root', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cds-mcp-root-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const project = join(directory, 'project')
    await mkdir(project)

    assert.equal(await resolveProjectPath(project, [directory]), await realpath(project))
  })

  test('rejects paths outside roots and sibling paths with a shared prefix', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cds-mcp-root-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const root = join(directory, 'workspace')
    const sibling = join(directory, 'workspace-secret')
    await Promise.all([mkdir(root), mkdir(sibling)])

    await assert.rejects(resolveProjectPath(sibling, [root]), /outside the configured workspace roots/)
  })

  test('rejects a symlink that escapes a workspace root', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cds-mcp-root-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const root = join(directory, 'workspace')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(root), mkdir(outside)])
    const link = join(root, 'linked-project')
    await symlink(outside, link)

    await assert.rejects(resolveProjectPath(link, [root]), /outside the configured workspace roots/)
  })

  test('uses MCP file roots when the client advertises them', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cds-mcp-root-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const root = join(directory, 'workspace')
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    let requestOptions
    const server = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async (_params, options) => {
        requestOptions = options
        return { roots: [{ uri: pathToFileURL(root).href }] }
      }
    }

    const resolver = createMcpProjectPathResolver(server, { fallbackRoot: directory, timeout: 123 })
    assert.equal((await resolver(project)).projectPath, await realpath(project))
    assert.deepEqual(requestOptions, { timeout: 123, maxTotalTimeout: 123 })
    await assert.rejects(resolver(directory), /outside the configured workspace roots/)
  })

  test('falls back to the server working directory for clients without roots support', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cds-mcp-root-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const project = join(directory, 'project')
    await mkdir(project)
    const server = { getClientCapabilities: () => ({}) }

    const resolver = createMcpProjectPathResolver(server, { fallbackRoot: directory })
    assert.equal((await resolver(project)).projectPath, await realpath(project))
  })

  test('fails closed when MCP roots cannot be obtained', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cds-mcp-root-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const server = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => {
        throw new Error('client unavailable')
      }
    }

    const resolver = createMcpProjectPathResolver(server, { fallbackRoot: directory })
    await assert.rejects(resolver(directory), /Unable to determine MCP workspace roots: client unavailable/)
  })

  test('fails closed with a specific error when all advertised roots are invalid', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cds-mcp-root-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const project = join(directory, 'project')
    await mkdir(project)
    const server = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({ roots: [{ uri: pathToFileURL(join(directory, 'missing')).href }] })
    }

    const resolver = createMcpProjectPathResolver(server, { fallbackRoot: directory })
    await assert.rejects(resolver(project), /No valid workspace roots are configured/)
  })
})
