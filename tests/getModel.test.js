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
  await assert.rejects(getModel(missingProject), /No CDS files|Couldn't find a CDS model/)
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
    JSON.stringify({ cds: { fiori: { draft_new_action: draftNewAction }, protocols: { 'odata-v4': { path: protocolPath } } } })
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
