import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOTS_TIMEOUT_MS = 5000

export class WorkspaceAccessError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'WorkspaceAccessError'
    this.code = 'ERR_WORKSPACE_ACCESS'
  }
}

const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

const canonicalDirectory = async directory => {
  const canonical = await realpath(path.resolve(directory))
  if (!(await stat(canonical)).isDirectory()) throw new Error('Not a directory')
  return canonical
}

export async function resolveProjectPath(projectPath, roots) {
  return (await authorizeProjectPath(projectPath, roots)).projectPath
}

export async function authorizeProjectPath(projectPath, roots) {
  if (!projectPath) throw new Error('A project path is required')

  let project
  try {
    project = await canonicalDirectory(projectPath)
  } catch (error) {
    throw new Error('Invalid project path', { cause: error })
  }

  const canonicalRoots = (await Promise.allSettled(roots.map(root => canonicalDirectory(root))))
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value)

  if (canonicalRoots.length === 0) {
    throw new WorkspaceAccessError('No valid workspace roots are configured')
  }

  if (!canonicalRoots.some(root => isWithin(root, project))) {
    throw new WorkspaceAccessError('Project path is outside the configured workspace roots')
  }

  return { projectPath: project, workspaceRoots: canonicalRoots }
}

export async function resolvePathsWithinRoots(paths, roots) {
  const canonicalRoots = (await Promise.allSettled(roots.map(root => canonicalDirectory(root))))
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value)

  const canonicalSources = await resolvePaths(paths)

  if (canonicalSources.some(source => !canonicalRoots.some(root => isWithin(root, source)))) {
    throw new WorkspaceAccessError('CDS model source is outside the configured workspace roots')
  }
  return canonicalSources
}

export function resolvePaths(paths) {
  return Promise.all(
    paths.map(async source => {
      try {
        return await realpath(path.resolve(source))
      } catch (error) {
        throw new Error('Invalid CDS model source', { cause: error })
      }
    })
  )
}

export function createMcpProjectPathResolver(
  server,
  { fallbackRoot = process.cwd(), timeout = DEFAULT_ROOTS_TIMEOUT_MS } = {}
) {
  return async projectPath => {
    const capabilities = server.getClientCapabilities()
    if (!capabilities?.roots) return authorizeProjectPath(projectPath, [fallbackRoot])

    let result
    try {
      result = await server.listRoots(undefined, { timeout, maxTotalTimeout: timeout })
    } catch (error) {
      throw new Error('Unable to determine MCP workspace roots', { cause: error })
    }

    let roots
    try {
      roots = result.roots.map(root => fileURLToPath(root.uri))
    } catch (error) {
      throw new Error('Invalid MCP workspace root', { cause: error })
    }
    return authorizeProjectPath(projectPath, roots)
  }
}
