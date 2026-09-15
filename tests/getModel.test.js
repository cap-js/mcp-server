import assert from 'node:assert'
import fs from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import cds from '@sap/cds'
import getModel from '../lib/getModel.js'

const nodeRequire = createRequire(import.meta.url)
const cdsPackageRoot = path.dirname(nodeRequire.resolve('@sap/cds/package.json'))
const projects = []
const originalCdsRoot = cds.root
const originalCdsModel = cds.model
const originalCdsEnv = cds.env

test.beforeEach(() => {
  cds.root = originalCdsRoot
  cds.model = originalCdsModel
  cds.env = originalCdsEnv
})

test.afterEach(async () => {
  cds.root = originalCdsRoot
  cds.model = originalCdsModel
  cds.env = originalCdsEnv
  await Promise.all(projects.splice(0).map(project => rm(project, { recursive: true, force: true })))
})

test('isolates compiler configuration captured during lazy module loading', async () => {
  const projectA = await createDraftProject('AlphaService', 'newA', '/alpha-prefix')
  const projectB = await createDraftProject('BetaService', 'newB', '/beta-prefix')
  const cdsChildReferencesBefore = cdsChildReferences()

  const modelA = await getModel(projectA)
  const modelB = await getModel(projectB)
  const entityA = modelA.definitions['AlphaService.Items']
  const entityB = modelB.definitions['BetaService.Items']

  assert.equal(entityA['@Common.DraftRoot.NewAction'], 'AlphaService.newA')
  assert(entityA.actions.newA)
  assert.equal(entityB['@Common.DraftRoot.NewAction'], 'BetaService.newB')
  assert(entityB.actions.newB)
  assert(!entityB.actions.newA)
  assert.equal(modelA.definitions.AlphaService.endpoints[0].path, 'alpha-prefix/alpha/')
  assert.equal(modelB.definitions.BetaService.endpoints[0].path, 'beta-prefix/beta/')
  for (let iteration = 0; iteration < 3; iteration++) {
    assert((await getModel(projectA)).definitions['AlphaService.Items'].actions.newA)
    assert((await getModel(projectB)).definitions['BetaService.Items'].actions.newB)
  }
  assert.equal(cdsChildReferences(), cdsChildReferencesBefore)
  assert.strictEqual(globalThis.cds, cds)
})

test('keeps models isolated across sequential project calls and failures', async () => {
  const projectA = await createProject('ServiceA', 'BooksA')
  const projectB = await createProject('ServiceB', 'BooksB')
  const missingProject = path.join(os.tmpdir(), `missing-cds-project-${Date.now()}`)

  const modelA = await getModel(projectA)
  const modelB = await getModel(projectB)

  assert.notStrictEqual(modelA, modelB)
  assert(modelA.definitions.ServiceA)
  assert(!modelA.definitions.ServiceB)
  assert(modelB.definitions.ServiceB)
  assert(!modelB.definitions.ServiceA)
  await assert.rejects(getModel(missingProject), /Failed to compile CDS model/)
})

test('terminates compiler workers after success and failure when project configuration leaves an active handle', async () => {
  const project = await createProject('WorkerService', 'WorkerBooks')
  const marker = path.join(project, 'config-loaded')
  await writeFile(
    path.join(project, '.cdsrc.js'),
    `const fs = require('node:fs'); fs.writeFileSync(__dirname + '/config-loaded', ''); setInterval(() => {}, 1000); module.exports = {}`
  )

  const model = await getModel(project)

  assert(model.definitions.WorkerService)
  assert(fs.existsSync(marker))

  const invalidProject = await createProject('InvalidWorkerService', 'InvalidWorkerBooks')
  const invalidMarker = path.join(invalidProject, 'config-loaded')
  await writeFile(
    path.join(invalidProject, '.cdsrc.js'),
    `const fs = require('node:fs'); fs.writeFileSync(__dirname + '/config-loaded', ''); setInterval(() => {}, 1000); module.exports = {}`
  )
  await writeFile(path.join(invalidProject, 'srv', 'service.cds'), 'this is not valid CDS')

  await assert.rejects(getModel(invalidProject))
  assert(fs.existsSync(invalidMarker))
})

test('serializes concurrent project loading with isolated CDS globals and configuration', async () => {
  const projectA = await createProject('ConcurrentServiceA', 'ConcurrentBooksA', false)
  const projectB = await createProject('ConcurrentServiceB', 'ConcurrentBooksB', true)
  const missingProject = path.join(os.tmpdir(), `missing-concurrent-cds-project-${Date.now()}`)
  const previousRoot = cds.root
  const previousModel = { sentinel: true }
  const previousLoad = cds.load
  const previousCompile = cds.compile
  const previousResolve = cds.resolve
  const originalReaddir = fs.promises.readdir
  const projectRoots = new Set([projectA, projectB, missingProject])
  let activeScans = 0
  let maxActiveScans = 0

  cds.model = previousModel
  fs.promises.readdir = async (directory, ...args) => {
    if (!projectRoots.has(path.resolve(directory))) return originalReaddir.call(fs.promises, directory, ...args)
    activeScans++
    maxActiveScans = Math.max(maxActiveScans, activeScans)
    try {
      await new Promise(resolve => setTimeout(resolve, 20))
      return await originalReaddir.call(fs.promises, directory, ...args)
    } finally {
      activeScans--
    }
  }

  try {
    const [resultA, resultB, missingResult] = await Promise.allSettled([
      getModel(projectA),
      getModel(projectB),
      getModel(missingProject)
    ])

    assert.equal(resultA.status, 'fulfilled')
    assert.equal(resultB.status, 'fulfilled')
    assert.equal(missingResult.status, 'rejected')
    assert.equal(maxActiveScans, 1)
    assert(resultA.value.definitions.ConcurrentServiceA)
    assert(!resultA.value.definitions.ConcurrentServiceB)
    assert(resultB.value.definitions.ConcurrentServiceB)
    assert(!resultB.value.definitions.ConcurrentServiceA)
    assert.equal(resultA.value._compat_texts_entities, undefined)
    assert.equal(resultB.value._compat_texts_entities, true)
    assert.strictEqual(cds.root, previousRoot)
    assert.strictEqual(cds.model, previousModel)
    assert.strictEqual(cds.env, originalCdsEnv)
    assert.strictEqual(cds.load, previousLoad)
    assert.strictEqual(cds.compile, previousCompile)
    assert.strictEqual(cds.resolve, previousResolve)
  } finally {
    fs.promises.readdir = originalReaddir
    cds.root = previousRoot
    cds.model = originalCdsModel
  }
})

test('refreshes on request and retries a failed refresh', async () => {
  const project = await createProject('RefreshService', 'RefreshBooks')
  const servicePath = path.join(project, 'srv', 'service.cds')
  const originalModel = await getModel(project)
  const invalidMtime = new Date(Date.now() + 2000)
  const validMtime = new Date(Date.now() + 4000)

  assert.strictEqual(await getModel(project), originalModel)

  await writeFile(servicePath, 'this is not valid CDS')
  await utimes(servicePath, invalidMtime, invalidMtime)
  assert.strictEqual(await getModel(project), originalModel)

  await writeFile(
    servicePath,
    `using { RefreshBooks } from '../db/schema'; service RefreshedService { entity Items as projection on RefreshBooks; }`
  )
  await utimes(servicePath, validMtime, validMtime)
  const refreshedModel = await getModel(project)

  assert.notStrictEqual(refreshedModel, originalModel)
  assert(refreshedModel.definitions.RefreshedService)
  assert(!refreshedModel.definitions.RefreshService)
})

test('refreshes cached models when CAP project configuration changes', async () => {
  const packageProject = await createDraftProject('PackageConfigService', 'newItem', '/first')
  const packagePath = path.join(packageProject, 'package.json')
  const packageModel = await getModel(packageProject)

  assert.equal(packageModel.definitions.PackageConfigService.endpoints[0].path, 'first/package-config/')

  await writeFile(
    packagePath,
    JSON.stringify({ cds: { fiori: { draft_new_action: 'newItem' }, protocols: { 'odata-v4': { path: '/second' } } } })
  )
  await utimes(packagePath, new Date(Date.now() + 2000), new Date(Date.now() + 2000))

  const refreshedPackageModel = await getModel(packageProject)
  assert.notStrictEqual(refreshedPackageModel, packageModel)
  assert.equal(refreshedPackageModel.definitions.PackageConfigService.endpoints[0].path, 'second/package-config/')

  const cdsrcProject = await createProject('CdsrcConfigService', 'CdsrcConfigBooks')
  const cdsrcPath = path.join(cdsrcProject, '.cdsrc.js')
  await writeFile(cdsrcPath, "module.exports = { protocols: { 'odata-v4': { path: '/first' } } }")
  const cdsrcModel = await getModel(cdsrcProject)

  assert.equal(cdsrcModel.definitions.CdsrcConfigService.endpoints[0].path, 'first/cdsrc-config/')

  await writeFile(cdsrcPath, "module.exports = { protocols: { 'odata-v4': { path: '/second' } } }")
  await utimes(cdsrcPath, new Date(Date.now() + 4000), new Date(Date.now() + 4000))

  const refreshedCdsrcModel = await getModel(cdsrcProject)
  assert.notStrictEqual(refreshedCdsrcModel, cdsrcModel)
  assert.equal(refreshedCdsrcModel.definitions.CdsrcConfigService.endpoints[0].path, 'second/cdsrc-config/')
})

test('refreshes cached models when transitive CAP configuration dependencies change', async () => {
  const project = await createProject('TransitiveConfigService', 'TransitiveConfigBooks')
  const configPath = path.join(project, 'cds-config.js')
  await writeFile(path.join(project, '.cdsrc.js'), "module.exports = require('./cds-config')")
  await writeFile(configPath, "module.exports = { protocols: { 'odata-v4': { path: '/first' } } }")

  const model = await getModel(project)
  assert.equal(model.definitions.TransitiveConfigService.endpoints[0].path, 'first/transitive-config/')

  await writeFile(configPath, "module.exports = { protocols: { 'odata-v4': { path: '/second' } } }")
  await utimes(configPath, new Date(Date.now() + 2000), new Date(Date.now() + 2000))

  const refreshedModel = await getModel(project)
  assert.notStrictEqual(refreshedModel, model)
  assert.equal(refreshedModel.definitions.TransitiveConfigService.endpoints[0].path, 'second/transitive-config/')
})

test('refreshes cached models when directory-valued CDS_CONFIG files change', async () => {
  const project = await createProject('DirectoryConfigService', 'DirectoryConfigBooks')
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'cds-mcp-config-'))
  projects.push(configDirectory)
  const protocolDirectory = path.join(configDirectory, 'protocols', 'odata-v4')
  const protocolPath = path.join(protocolDirectory, 'path')
  await mkdir(protocolDirectory, { recursive: true })
  await writeFile(protocolPath, '/first')
  const previousConfig = process.env.CDS_CONFIG
  process.env.CDS_CONFIG = configDirectory

  try {
    const model = await getModel(project)
    assert.equal(model.definitions.DirectoryConfigService.endpoints[0].path, 'first/directory-config/')

    await writeFile(protocolPath, '/second')
    await utimes(protocolPath, new Date(Date.now() + 2000), new Date(Date.now() + 2000))

    const refreshedModel = await getModel(project)
    assert.notStrictEqual(refreshedModel, model)
    assert.equal(refreshedModel.definitions.DirectoryConfigService.endpoints[0].path, 'second/directory-config/')
  } finally {
    if (previousConfig === undefined) delete process.env.CDS_CONFIG
    else process.env.CDS_CONFIG = previousConfig
  }
})

test('refreshes cached models when pom.xml changes CAP project nature', async () => {
  const project = await createProject('JavaProfileService', 'JavaProfileBooks')
  await writeFile(
    path.join(project, '.cdsrc.json'),
    JSON.stringify({ '[java]': { features: { compat_texts_entities: true } } })
  )
  const model = await getModel(project)

  assert.equal(model._compat_texts_entities, undefined)

  const pomPath = path.join(project, 'pom.xml')
  await writeFile(pomPath, '<project/>')
  await utimes(pomPath, new Date(Date.now() + 2000), new Date(Date.now() + 2000))

  const refreshedModel = await getModel(project)
  assert.notStrictEqual(refreshedModel, model)
  assert.equal(refreshedModel._compat_texts_entities, true)
})

test('recompiles when project files change between compilation and snapshotting', async () => {
  const project = await createProject('InitialRaceService', 'RaceBooks')
  const servicePath = path.join(project, 'srv', 'service.cds')
  const markerPath = path.join(project, 'compile-started')
  await writeFile(
    path.join(project, '.cdsrc.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, ''); module.exports = {}`
  )
  await getModel(project)
  await rm(markerPath)
  await writeFile(
    servicePath,
    "using { RaceBooks } from '../db/schema'; service IntermediateRaceService { entity Items as projection on RaceBooks; }"
  )
  await utimes(servicePath, new Date(Date.now() + 2000), new Date(Date.now() + 2000))

  const originalLstat = fs.promises.lstat
  let changedDuringSnapshot = false
  fs.promises.lstat = async (file, ...args) => {
    if (!changedDuringSnapshot && path.resolve(file) === servicePath && fs.existsSync(markerPath)) {
      changedDuringSnapshot = true
      fs.writeFileSync(
        servicePath,
        "using { RaceBooks } from '../db/schema'; service LatestRaceService { entity Items as projection on RaceBooks; }"
      )
      const latestMtime = new Date(Date.now() + 4000)
      fs.utimesSync(servicePath, latestMtime, latestMtime)
    }
    return originalLstat.call(fs.promises, file, ...args)
  }

  let model
  try {
    model = await getModel(project)
  } finally {
    fs.promises.lstat = originalLstat
  }

  assert(changedDuringSnapshot)
  assert(model.definitions.LatestRaceService)
  assert(!model.definitions.IntermediateRaceService)
})

test('recompiles when a newly discovered external source changes during compilation', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cds-mcp-race-workspace-'))
  projects.push(workspace)
  const project = path.join(workspace, 'project')
  const sharedDirectory = path.join(workspace, 'shared')
  const sharedModelPath = path.join(sharedDirectory, 'model.cds')
  const markerPath = path.join(project, 'compile-started')
  await Promise.all([mkdir(path.join(project, 'srv'), { recursive: true }), mkdir(sharedDirectory)])
  await writeFile(
    path.join(project, '.cdsrc.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, ''); module.exports = {}`
  )
  await writeFile(sharedModelPath, 'entity SharedBooks { key ID: Integer; initial: String; }')
  await writeFile(
    path.join(project, 'srv', 'service.cds'),
    "using { SharedBooks } from '../../shared/model'; service ExternalRaceService { entity Books as projection on SharedBooks; }"
  )
  const canonicalSharedModelPath = await fs.promises.realpath(sharedModelPath)

  const originalLstat = fs.promises.lstat
  let changedDuringSnapshot = false
  fs.promises.lstat = async (file, ...args) => {
    if (!changedDuringSnapshot && path.resolve(file) === canonicalSharedModelPath && fs.existsSync(markerPath)) {
      changedDuringSnapshot = true
      fs.writeFileSync(sharedModelPath, 'entity SharedBooks { key ID: Integer; latest: String; }')
      const latestMtime = new Date(Date.now() + 2000)
      fs.utimesSync(sharedModelPath, latestMtime, latestMtime)
    }
    return originalLstat.call(fs.promises, file, ...args)
  }

  let model
  try {
    model = await getModel(project, [workspace])
  } finally {
    fs.promises.lstat = originalLstat
  }

  assert(changedDuringSnapshot)
  assert(model.definitions.SharedBooks.elements.latest)
  assert(!model.definitions.SharedBooks.elements.initial)
})

test('preserves the cached model when an unrelated workspace root changes during a failed refresh', async () => {
  const project = await createProject('RootChangeService', 'RootChangeBooks')
  const additionalRoot = await mkdtemp(path.join(os.tmpdir(), 'cds-mcp-additional-root-'))
  projects.push(additionalRoot)
  const servicePath = path.join(project, 'srv', 'service.cds')
  const originalModel = await getModel(project, [project])

  await writeFile(servicePath, 'this is not valid CDS')
  await utimes(servicePath, new Date(Date.now() + 2000), new Date(Date.now() + 2000))

  assert.strictEqual(await getModel(project, [project, additionalRoot]), originalModel)
})

test('keeps a successful compilation when timestamp collection remains unavailable', async () => {
  const project = await createProject('SnapshotService', 'SnapshotBooks')
  const unreadableDirectory = path.join(project, 'unrelated')
  await mkdir(unreadableDirectory)
  const originalReaddir = fs.promises.readdir

  fs.promises.readdir = async (directory, ...args) => {
    if (path.resolve(directory) === unreadableDirectory) throw new Error('directory temporarily unavailable')
    return originalReaddir.call(fs.promises, directory, ...args)
  }

  let model
  try {
    model = await getModel(project)
    assert(model.definitions.SnapshotService)
  } finally {
    fs.promises.readdir = originalReaddir
  }

  const modelWithSnapshot = await getModel(project)
  assert.notStrictEqual(modelWithSnapshot, model)
  assert(modelWithSnapshot.definitions.SnapshotService)
})

test('rejects a CDS source reached through an escaping symlink', async () => {
  const project = await createProject('SymlinkService', 'SymlinkBooks')
  const outside = await mkdtemp(path.join(os.tmpdir(), 'cds-mcp-outside-'))
  projects.push(outside)
  const outsideModel = path.join(outside, 'outside.cds')
  await writeFile(outsideModel, 'entity Outside { key ID: Integer; }')
  await symlink(outsideModel, path.join(project, 'srv', 'linked.cds'))

  await assert.rejects(getModel(project), error => {
    assert.equal(error.name, 'WorkspaceAccessError')
    assert.match(error.message, /CDS model source is outside the configured workspace roots/)
    return true
  })
})

test('revalidates a newly added symlink source across the compiler worker boundary', async () => {
  const project = await createProject('CachedSymlinkService', 'CachedSymlinkBooks')
  const model = await getModel(project)
  const outside = await mkdtemp(path.join(os.tmpdir(), 'cds-mcp-outside-'))
  projects.push(outside)
  const outsideModel = path.join(outside, 'outside.cds')
  await writeFile(outsideModel, 'entity Outside { key ID: Integer; }')
  await symlink(outsideModel, path.join(project, 'srv', 'linked.cds'))

  assert(model.definitions.CachedSymlinkService)
  await assert.rejects(getModel(project), error => {
    assert.equal(error.name, 'WorkspaceAccessError')
    assert.match(error.message, /CDS model source is outside the configured workspace roots/)
    return true
  })
})

test('rejects transitive CDS sources outside the workspace roots', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cds-mcp-workspace-'))
  projects.push(workspace)
  const project = path.join(workspace, 'project')
  const outside = path.join(workspace, 'outside')
  await Promise.all([mkdir(path.join(project, 'srv'), { recursive: true }), mkdir(outside)])
  await writeFile(path.join(outside, 'model.cds'), 'entity Outside { key ID: Integer; }')
  await writeFile(
    path.join(project, 'srv', 'service.cds'),
    "using { Outside } from '../../outside/model'; service EscapingService { entity Items as projection on Outside; }"
  )

  await assert.rejects(getModel(project), error => {
    assert.equal(error.name, 'WorkspaceAccessError')
    assert.match(error.message, /CDS model source is outside the configured workspace roots/)
    return true
  })

  const model = await getModel(project, [workspace])
  assert(model.definitions.EscapingService)
  await writeFile(path.join(outside, 'model.cds'), 'this is not valid CDS')
  await assert.rejects(getModel(project, [project]), error => {
    assert.equal(error.name, 'WorkspaceAccessError')
    assert.match(error.message, /CDS model source is outside the configured workspace roots/)
    return true
  })
})

test('does not expose compiler diagnostics from outside workspace roots', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cds-mcp-workspace-'))
  projects.push(workspace)
  const project = path.join(workspace, 'project')
  const outside = path.join(workspace, 'private')
  const outsideModel = path.join(outside, 'model.cds')
  await Promise.all([mkdir(path.join(project, 'srv'), { recursive: true }), mkdir(outside)])
  await writeFile(outsideModel, 'entity SECRET_CUSTOMER_TABLE { key ID Integer; }')
  await writeFile(
    path.join(project, 'srv', 'service.cds'),
    "using { SECRET_CUSTOMER_TABLE } from '../../private/model'; service LeakingService { entity Items as projection on SECRET_CUSTOMER_TABLE; }"
  )

  await assert.rejects(getModel(project), error => {
    assert.equal(error.message, 'Failed to compile CDS model')
    assert(!error.message.includes(outsideModel))
    assert(!error.message.includes('SECRET_CUSTOMER_TABLE'))
    return true
  })
})

async function createProject(serviceName, entityName, compatTextsEntities) {
  const project = await mkdtemp(path.join(os.tmpdir(), 'cds-mcp-model-'))
  projects.push(project)
  await mkdir(path.join(project, 'db'))
  await mkdir(path.join(project, 'srv'))
  if (compatTextsEntities !== undefined) {
    await writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({ cds: { features: { compat_texts_entities: compatTextsEntities } } })
    )
  }
  await writeFile(path.join(project, 'db', 'schema.cds'), `entity ${entityName} { key ID: Integer; }`)
  await writeFile(
    path.join(project, 'srv', 'service.cds'),
    `using { ${entityName} } from '../db/schema'; service ${serviceName} { entity Items as projection on ${entityName}; }`
  )
  return project
}

async function createDraftProject(serviceName, draftNewAction, protocolPath) {
  const project = await mkdtemp(path.join(os.tmpdir(), 'cds-mcp-draft-model-'))
  projects.push(project)
  await mkdir(path.join(project, 'db'))
  await mkdir(path.join(project, 'srv'))
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({
      cds: { fiori: { draft_new_action: draftNewAction }, protocols: { 'odata-v4': { path: protocolPath } } }
    })
  )
  await writeFile(path.join(project, 'db', 'schema.cds'), '')
  await writeFile(
    path.join(project, 'srv', 'service.cds'),
    `service ${serviceName} { @odata.draft.enabled entity Items { key ID: Integer; }; }`
  )
  return project
}

function cdsChildReferences() {
  return Object.values(nodeRequire.cache).reduce(
    (count, module) => count + module.children.filter(child => child.id.startsWith(cdsPackageRoot + path.sep)).length,
    0
  )
}
