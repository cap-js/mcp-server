import assert from 'node:assert'
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import cds from '@sap/cds'
import getModel from '../lib/getModel.js'

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

test('serializes concurrent project compilations with isolated CDS globals and configuration', async () => {
  const projectA = await createProject('ConcurrentServiceA', 'ConcurrentBooksA', false)
  const projectB = await createProject('ConcurrentServiceB', 'ConcurrentBooksB', true)
  const missingProject = path.join(os.tmpdir(), `missing-concurrent-cds-project-${Date.now()}`)
  const previousRoot = cds.root
  const previousModel = { sentinel: true }
  const originalLoad = cds.load
  let activeLoads = 0
  let maxActiveLoads = 0

  cds.model = previousModel
  cds.load = async (...args) => {
    activeLoads++
    maxActiveLoads = Math.max(maxActiveLoads, activeLoads)
    await new Promise(resolve => setTimeout(resolve, 20))
    try {
      return await originalLoad.call(cds, ...args)
    } finally {
      activeLoads--
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
    assert.equal(maxActiveLoads, 1)
    assert(resultA.value.definitions.ConcurrentServiceA)
    assert(!resultA.value.definitions.ConcurrentServiceB)
    assert(resultB.value.definitions.ConcurrentServiceB)
    assert(!resultB.value.definitions.ConcurrentServiceA)
    assert.equal(resultA.value._compat_texts_entities, undefined)
    assert.equal(resultB.value._compat_texts_entities, true)
    assert.strictEqual(cds.root, previousRoot)
    assert.strictEqual(cds.model, previousModel)
    assert.strictEqual(cds.env, originalCdsEnv)
  } finally {
    cds.load = originalLoad
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

test('rejects a CDS source reached through an escaping symlink', async () => {
  const project = await createProject('SymlinkService', 'SymlinkBooks')
  const outside = await mkdtemp(path.join(os.tmpdir(), 'cds-mcp-outside-'))
  projects.push(outside)
  const outsideModel = path.join(outside, 'outside.cds')
  await writeFile(outsideModel, 'entity Outside { key ID: Integer; }')
  await symlink(outsideModel, path.join(project, 'srv', 'linked.cds'))

  await assert.rejects(getModel(project), /CDS model source is outside the configured workspace roots/)
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

  await assert.rejects(getModel(project), /CDS model source is outside the configured workspace roots/)

  const model = await getModel(project, [workspace])
  assert(model.definitions.EscapingService)
  await assert.rejects(getModel(project, [project]), /CDS model source is outside the configured workspace roots/)
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
