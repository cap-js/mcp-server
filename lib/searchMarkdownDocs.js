import { createRequire } from 'node:module'
import { loadChunks, searchEmbeddings } from './embeddings.js'
import { DEFAULT_DIR, DEFAULT_EMBEDDINGS_DIR, DEFAULT_EMBEDDINGS_URL, MODEL_FOLDER } from './calculateEmbeddings.js'
import fs from 'fs/promises'
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import semver from 'semver'

const manifestEtagPath = path.join(DEFAULT_DIR, 'manifest.etag')

function parseJavaCdsVersion(text) {
  // Maven property: <cds.services.version>4.9.0</cds.services.version>
  const prop = text.match(/<cds\.services\.version>([^<]+)<\/cds\.services\.version>/)
  if (prop) return prop[1]
  // Gradle: id 'com.sap.cds.cds-services-bom' version '4.9.0'
  const gradle = text.match(/com\.sap\.cds[^\s'"]*['"]?\s+version\s+['"]([^'"]+)['"]/)
  if (gradle) return gradle[1]
  return undefined
}

export function detectRuntime(cwd = process.cwd()) {
  // 1. Node — @sap/cds present in caller's module graph
  try {
    const require = createRequire(path.join(cwd, 'package.json'))
    const pkg = require('@sap/cds/package.json')
    return { runtime: 'node', cdsVersion: pkg.version }
  } catch { /* not a cds node project */ }

  // 2. Java — walk up looking for pom.xml or build.gradle*
  let dir = cwd
  while (true) {
    for (const name of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
      const f = path.join(dir, name)
      if (!existsSync(f)) continue
      const text = readFileSync(f, 'utf8')
      if (!/com\.sap\.cds/.test(text)) continue
      return { runtime: 'java', cdsVersion: parseJavaCdsVersion(text) }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return { runtime: undefined, cdsVersion: undefined }
}


function getBundleUrl() {
  const base = DEFAULT_EMBEDDINGS_URL.replace(/\/[^/]+$/, '')
  const { runtime, cdsVersion } = detectRuntime()
  const params = new URLSearchParams({ model: MODEL_FOLDER })
  if (runtime) params.set('runtime', runtime)
  if (cdsVersion) params.set('cds', cdsVersion)
  return `${base}/getEmbeddings?${params.toString()}`
}

async function checkFilesExist(jsonPath, binPath) {
  const [j, b] = await Promise.all([
    fs.access(jsonPath).then(() => true).catch(() => false),
    fs.access(binPath).then(() => true).catch(() => false)
  ])
  return j && b
}

export async function resolveLocalVersion() {
  let entries
  try {
    entries = await fs.readdir(DEFAULT_EMBEDDINGS_DIR, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(DEFAULT_EMBEDDINGS_DIR, e.name)
    const ok = await checkFilesExist(path.join(dir, 'code-chunks.json'), path.join(dir, 'code-chunks.bin'))
    if (ok) candidates.push({ version: e.name, localDir: dir })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => semver.rcompare(semver.coerce(a.version) ?? '0.0.0', semver.coerce(b.version) ?? '0.0.0'))
  return candidates[0]
}

export async function downloadEmbeddings() {
  const cachedEtag = await fs.readFile(manifestEtagPath, 'utf-8').catch(() => null)
  const headers = cachedEtag ? { 'If-None-Match': cachedEtag.trim() } : {}
  const resp = await fetch(getBundleUrl(), { headers })

  if (resp.status === 304) {
    // Manifest unchanged → newest local versioned dir is the version server
    // would have served us. Fall back to resolveLocalVersion instead of a
    // dedicated marker file.
    const local = await resolveLocalVersion()
    if (!local) throw new Error('Bundle 304 but no local versioned embeddings found; delete manifest.etag to force refetch')
    return { updated: false, version: local.version, localDir: local.localDir }
  }
  if (!resp.ok) throw new Error(`Failed to fetch bundle: ${resp.status} ${resp.statusText}`)

  const version = resp.headers.get('x-embeddings-version')
  if (!version) throw new Error('Bundle response missing X-Embeddings-Version header')
  const newEtag = resp.headers.get('etag')

  const { embeddings, ...meta } = await resp.json()
  if (typeof embeddings !== 'string') throw new Error('Bundle response missing embeddings (base64)')

  const localDir = path.join(DEFAULT_EMBEDDINGS_DIR, version)
  await fs.mkdir(localDir, { recursive: true })
  const jsonPath = path.join(localDir, 'code-chunks.json')
  const binPath = path.join(localDir, 'code-chunks.bin')
  const tempJsonPath = jsonPath + '.tmp'
  const tempBinPath = binPath + '.tmp'

  try {
    await fs.writeFile(tempJsonPath, JSON.stringify(meta))
    await fs.writeFile(tempBinPath, Buffer.from(embeddings, 'base64'))
    await fs.rename(tempJsonPath, jsonPath)
    await fs.rename(tempBinPath, binPath)
  } catch (writeError) {
    await fs.unlink(tempJsonPath).catch(() => {})
    await fs.unlink(tempBinPath).catch(() => {})
    throw writeError
  }

  if (newEtag) await fs.writeFile(manifestEtagPath, newEtag).catch(() => {})

  return { updated: true, version, localDir }
}

const offline = process.argv.includes('--offline') || process.env.CDS_MCP_OFFLINE === 'true'

async function offlineSetup() {
  const local = await resolveLocalVersion()
  if (!local) throw new Error('Offline mode: no local embeddings version found under ' + DEFAULT_EMBEDDINGS_DIR)
  return { updated: false, version: local.version, offline: true, localDir: local.localDir }
}

let downloadPromise = offline ? offlineSetup() : downloadEmbeddings()

export function formatResult(r) {
  if (!r.meta) return r.content
  const header = Object.entries(r.meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return header ? `${header}\n\n${r.content}` : r.content
}

export default async function searchMarkdownDocs(query, maxResults = 10) {
  let localDir
  if (downloadPromise) localDir = await downloadPromise

  async function searchWithRetry(versionDir, retryCount = 0) {
    try {
      const chunks = await loadChunks('code-chunks', versionDir)
      const results = (await searchEmbeddings(query, chunks)).slice(0, maxResults)
      return results.map(formatResult).join('\n---\n')
    } catch (error) {
      if (error.code === 'EMBEDDINGS_CORRUPTED' && retryCount < 2) {
        if (offline) throw error
        downloadPromise = downloadEmbeddings()
        const { localDir: newDir } = await downloadPromise
        return searchWithRetry(newDir, retryCount + 1)
      }

      throw error
    }
  }

  return searchWithRetry(localDir)
}
