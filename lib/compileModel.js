import cds from '@sap/cds'
import { createRequire } from 'node:module'
import { statSync } from 'node:fs'
import path from 'node:path'
import { resolvePaths, resolvePathsWithinRoots } from './projectPath.js'

const nodeRequire = createRequire(import.meta.url)

cds.log.Logger = () => {
  return {
    trace: () => {},
    debug: () => {},
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  }
}

export default async function compileModel(projectPath, workspaceRoots = [projectPath]) {
  cds.root = projectPath
  const modulesBeforeConfiguration = new Set(Object.keys(nodeRequire.cache))
  cds.env = cds.env.for('cds', projectPath)
  const configurationFiles = [
    ...(cds.env._sources || []).filter(source => path.isAbsolute(source)),
    ...Object.keys(nodeRequire.cache).filter(
      source => path.isAbsolute(source) && !modulesBeforeConfiguration.has(source)
    )
  ]

  const allResolved = cds.resolve(projectPath + '/*', { cache: {} }) // use CAP standard resolution for model compilation
  // cds.resolve may return .cds build-output directories; filter to files only to avoid EISDIR on readFile
  const resolved = allResolved?.filter(f => { try { return statSync(f).isFile() } catch { return false } })
  if (!resolved?.length) {
    throw new Error(`No CDS files in path: ${projectPath}`)
  }

  await validateModelSources(resolved, workspaceRoots)
  let compiled = await cds.load(resolved, { docs: true, locations: true })
  if (!compiled || (Array.isArray(compiled) && compiled.length === 0)) {
    throw new Error(`Failed to load CDS model from path: ${projectPath}`)
  }
  if (!compiled.definitions || Object.keys(compiled.definitions).length === 0) {
    throw new Error(`Compiled CDS model is invalid or empty for path: ${projectPath}`)
  }

  const sourceFiles = await validateModelSources(compiled.$sources || resolved, workspaceRoots)
  compiled = cds.compile.for.nodejs(compiled) // to include drafts, show effective types
  const serviceInfo = cds.compile.to.serviceinfo(compiled)

  // merge with definitions
  for (const info of serviceInfo) {
    const def = compiled.definitions[info.name]
    Object.assign(def, info)
  }

  for (const name in compiled.definitions) {
    Object.defineProperty(compiled.definitions[name], 'name', {
      value: name,
      enumerable: true
    })
  }

  const _entities_in = service => {
    const exposed = [],
      { entities } = service
    for (let each in entities) {
      const e = entities[each]
      if (e['@cds.autoexposed'] && !e['@cds.autoexpose']) continue
      if (/DraftAdministrativeData$/.test(e.name)) continue
      if (/[._]texts$/.test(e.name)) continue
      if (cds.env.effective.odata.containment && service.definition._containedEntities.has(e.name)) continue
      exposed.push(each)
    }
    return exposed
  }

  compiled.services.forEach(srv => {
    const entities = _entities_in(srv)
    srv.exposedEntities = entities.map(e => srv.name + '.' + e)
    if (srv.endpoints)
      srv.endpoints.forEach(endpoint => {
        for (const e of entities) {
          const path = endpoint.path + e.replace(/\./g, '_')
          const def = compiled.definitions[srv.name + '.' + e]
          def.endpoints ??= []
          def.endpoints.push({ kind: endpoint.kind, path })
        }
      })
  })

  return { model: compiled, sourceFiles, configurationFiles: [...new Set(configurationFiles)], compilerRoot: cds.home }
}

function validateModelSources(files, workspaceRoots) {
  const sources = [files].flat()
  return workspaceRoots ? resolvePathsWithinRoots(sources, [...workspaceRoots, cds.home]) : resolvePaths(sources)
}
