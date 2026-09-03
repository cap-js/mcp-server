import cds from '@sap/cds'

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

export default async function compileModel(projectPath) {
  cds.root = projectPath
  cds.env = cds.env.for('cds', projectPath)

  const resolved = cds.resolve(projectPath + '/*', { cache: {} }) // use CAP standard resolution for model compilation
  if (!resolved) {
    throw new Error(`No CDS files in path: ${projectPath}`)
  }
  let compiled = await cds.load(resolved, { docs: true, locations: true })
  if (!compiled || (Array.isArray(compiled) && compiled.length === 0)) {
    throw new Error(`Failed to load CDS model from path: ${projectPath}`)
  }
  if (!compiled.definitions || Object.keys(compiled.definitions).length === 0) {
    throw new Error(`Compiled CDS model is invalid or empty for path: ${projectPath}`)
  }
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

  return compiled
}
