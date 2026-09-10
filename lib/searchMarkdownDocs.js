import { createRequire } from 'node:module'
import { loadChunks, searchEmbeddings } from './embeddings.js'
import { DEFAULT_DIR, DEFAULT_EMBEDDINGS_DIR, DEFAULT_EMBEDDINGS_URL, MODEL_FOLDER } from './calculateEmbeddings.js'
import fs from 'fs/promises'
import { readFileSync } from 'fs'
import path from 'path'

function etagPathFor(cdsVersion) {
  return path.join(DEFAULT_DIR, 'etags', cdsVersion || 'latest', 'manifest.etag')
}

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
    const projectCds = require('@sap/cds')
    const runtime = projectCds.env['project-nature']
    if (runtime === 'nodejs') {
      return { runtime: 'node', cdsVersion: projectCds.version }
    }
  } catch { /* not a cds node project */ }

  // 2. Java — check cwd + srv/ first, then walk up.
  const BUILD_FILES = ['pom.xml', 'srv/pom.xml', 'build.gradle', 'build.gradle.kts']
  let dir = cwd
  while (true) {
    for (const name of BUILD_FILES) {
      let text
      try { text = readFileSync(path.join(dir, name), 'utf8') }
      catch { continue }
      if (!/com\.sap\.cds/.test(text)) continue
      return { runtime: 'java', cdsVersion: parseJavaCdsVersion(text) }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return { runtime: undefined, cdsVersion: undefined }
}


function getBundleUrl(runtime, cdsVersion) {
  const params = new URLSearchParams({ model: MODEL_FOLDER })
  if (runtime) params.set('runtime', runtime)
  if (cdsVersion) params.set('cds', cdsVersion)
  return `${DEFAULT_EMBEDDINGS_URL}/getEmbeddings?${params.toString()}`
}

async function checkFilesExist(jsonPath, binPath) {
  const [j, b] = await Promise.all([
    fs.access(jsonPath).then(() => true).catch(() => false),
    fs.access(binPath).then(() => true).catch(() => false)
  ])
  return j && b
}

function coerceVersion(str) {
  const m = str.match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? [+m[1], +m[2], +m[3]] : null
}

function versionGt(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

export async function resolveLocalVersion() {
  // Try etag file for the detected cds version first — it records the exact
  // commitId the server resolved for this runtime/cds combo last time we downloaded.
  const { cdsVersion } = detectRuntime()
  const etagPath = etagPathFor(cdsVersion)
  const cached = await fs.readFile(etagPath, 'utf-8').then(JSON.parse).catch(() => null)
  if (cached?.commitId) {
    const localDir = path.join(DEFAULT_EMBEDDINGS_DIR, cached.commitId)
    const ok = await checkFilesExist(path.join(localDir, 'code-chunks.json'), path.join(localDir, 'code-chunks.bin'))
    if (ok) return { commitId: cached.commitId, localDir }
  }

  // fallback use cached commitId with newest cds version
  let bestCds = null
  let best = null
  try {
    const cdsVersionDirs = await fs.readdir(path.join(DEFAULT_DIR, 'etags'), { withFileTypes: true })
    for (const d of cdsVersionDirs) {
      if (!d.isDirectory()) continue
      const coerced = coerceVersion(d.name)
      if (!coerced) continue
      if (bestCds && !versionGt(coerced, bestCds)) continue
      const ep = path.join(DEFAULT_DIR, 'etags', d.name, 'manifest.etag')
      try {
        const c = JSON.parse(await fs.readFile(ep, 'utf-8'))
        if (!c?.commitId) continue
        const localDir = path.join(DEFAULT_EMBEDDINGS_DIR, c.commitId)
        const ok = await checkFilesExist(path.join(localDir, 'code-chunks.json'), path.join(localDir, 'code-chunks.bin'))
        if (ok) { best = { commitId: c.commitId, localDir }; bestCds = coerced }
      } catch {}
    }
  } catch {}
  if (best) return best

  // last-resort: newest embedding folder by creation time (no etag needed)
  try {
    const entries = await fs.readdir(DEFAULT_EMBEDDINGS_DIR, { withFileTypes: true })
    let newestTime = -1
    let newestResult = null
    for (const d of entries) {
      if (!d.isDirectory()) continue
      const localDir = path.join(DEFAULT_EMBEDDINGS_DIR, d.name)
      const ok = await checkFilesExist(path.join(localDir, 'code-chunks.json'), path.join(localDir, 'code-chunks.bin'))
      if (!ok) continue
      const stat = await fs.stat(localDir).catch(() => null)
      if (!stat) continue
      const t = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
      if (t > newestTime) { newestTime = t; newestResult = { commitId: d.name, localDir } }
    }
    if (newestResult) return newestResult
  } catch {}
  return null
}

async function _downloadEmbeddings() {
  const { runtime, cdsVersion } = detectRuntime()
  const etagPath = etagPathFor(cdsVersion)
  const cached = await fs.readFile(etagPath, 'utf-8').then(JSON.parse).catch(() => null)
  const headers = cached?.etag ? { 'If-None-Match': cached.etag.trim() } : {}
  const resp = await fetch(getBundleUrl(runtime, cdsVersion), { headers })

  if (resp.status === 304) {
    // Manifest unchanged for this cds version. Use the commit id we
    // stored alongside the etag — that's the exact version the server would
    // resolve for these query params. Newest-local can differ on cds
    // downgrade or when multiple cds versions share the cache.
    const commitId = cached?.commitId
    if (!commitId) throw new Error(`Bundle 304 but no commitId in ${etagPath}; delete to force refetch`)
    const localDir = path.join(DEFAULT_EMBEDDINGS_DIR, commitId)
    const ok = await checkFilesExist(path.join(localDir, 'code-chunks.json'), path.join(localDir, 'code-chunks.bin'))
    if (!ok) throw new Error(`Bundle 304 but local dir ${localDir} missing files; delete ${etagPath} to force refetch`)
    return { updated: false, commitId, localDir }
  }
  if (!resp.ok) throw new Error(`Failed to fetch bundle: ${resp.status} ${resp.statusText}`)

  const commitId = resp.headers.get('x-embeddings-version')
  if (!commitId) throw new Error('Bundle response missing X-Embeddings-Version header')
  const newEtag = resp.headers.get('etag')

  // Binary frame: [4-byte BE meta length][meta JSON bytes][bin bytes].
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length < 4) throw new Error('Bundle response too short')
  const metaLen = buf.readUInt32BE(0)
  if (metaLen > buf.length - 4) throw new Error('Bundle framing: metaLen exceeds available bytes')
  if (metaLen === buf.length - 4) throw new Error('Bundle framing: metaLen leaves empty bin')
  const metaBytes = buf.subarray(4, 4 + metaLen)
  const binBytes = buf.subarray(4 + metaLen)

  const localDir = path.join(DEFAULT_EMBEDDINGS_DIR, commitId)
  await fs.mkdir(localDir, { recursive: true })
  const jsonPath = path.join(localDir, 'code-chunks.json')
  const binPath = path.join(localDir, 'code-chunks.bin')
  const tempJsonPath = jsonPath + '.tmp'
  const tempBinPath = binPath + '.tmp'

  try {
    await fs.writeFile(tempJsonPath, metaBytes)
    await fs.writeFile(tempBinPath, binBytes)
    await fs.rename(tempJsonPath, jsonPath)
    await fs.rename(tempBinPath, binPath)
  } catch (writeError) {
    await fs.unlink(tempJsonPath).catch(() => {})
    await fs.unlink(tempBinPath).catch(() => {})
    throw writeError
  }

  if (newEtag) {
    await fs.mkdir(path.dirname(etagPath), { recursive: true })
    await fs.writeFile(etagPath, JSON.stringify({ etag: newEtag, commitId })).catch(() => {})
  }

  return { updated: true, commitId, localDir }
}

let inFlightDownload = null
export function downloadEmbeddings() {
  if (inFlightDownload) return inFlightDownload
  inFlightDownload = _downloadEmbeddings().finally(() => { inFlightDownload = null })
  return inFlightDownload
}

const offline = process.argv.includes('--offline') || process.env.CDS_MCP_OFFLINE === 'true'

async function offlineSetup() {
  const local = await resolveLocalVersion()
  if (!local) throw new Error('Offline mode: no local embeddings version found under ' + DEFAULT_EMBEDDINGS_DIR)
  return { updated: false, commitId: local.commitId, offline: true, localDir: local.localDir }
}

let downloadPromise = offline ? offlineSetup() : downloadEmbeddings()
downloadPromise.catch(() => {})   // still fails when awaited by callers; only silences the module-load noise

export function formatResult(r) {
  if (!r.meta) return r.content
  const header = Object.entries(r.meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return header ? `${header}\n\n${r.content}` : r.content
}

export default async function searchMarkdownDocs(query, maxResults = 10) {
  let respDownload
  if (downloadPromise) respDownload = await downloadPromise

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

  return searchWithRetry(respDownload?.localDir)
}
