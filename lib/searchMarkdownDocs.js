import { loadChunks, searchEmbeddings } from './embeddings.js'
import { DEFAULT_DIR, DEFAULT_EMBEDDINGS_DIR, DEFAULT_EMBEDDINGS_URL, MODEL_FOLDER } from './calculateEmbeddings.js'
import fs from 'fs/promises'
import path from 'path'
import cds from '@sap/cds'
import semver from 'semver'

export async function resolveBestVersion() {
  const manifestUrl = `${DEFAULT_EMBEDDINGS_URL.replace(/\/[^/]+$/, '')}/versions.json`
  const manifestResp = await fetch(manifestUrl)
  if (!manifestResp.ok) return null
  const manifest = await manifestResp.json()
  const entries = manifest?.[MODEL_FOLDER]
  if (!Array.isArray(entries) || entries.length === 0) return null

  const cdsVersion = cds.version
  const suited = entries.filter(e => {
    if (!e?.version) return false
    if (!e.cdsDevDependency) return true
    try {
      return semver.satisfies(cdsVersion, e.cdsDevDependency, { includePrerelease: true })
    } catch {
      return false
    }
  })
  if (suited.length === 0) return null

  suited.sort((a, b) => semver.rcompare(semver.coerce(a.version) ?? '0.0.0', semver.coerce(b.version) ?? '0.0.0'))
  const best = suited[0]
  const localDir = path.join(DEFAULT_EMBEDDINGS_DIR, best.version)
  const jsonPath = path.join(localDir, 'code-chunks.json')
  const binPath = path.join(localDir, 'code-chunks.bin')
  const cached = await checkFilesExist(jsonPath, binPath)
  return {
    version: best.version,
    versionUrl: `${DEFAULT_EMBEDDINGS_URL}/${best.version}`,
    localDir,
    cached
  }
}

async function checkFilesExist(jsonPath, binPath) {
  const [jsonExists, binExists] = await Promise.all([
    fs.access(jsonPath).then(() => true).catch(() => false),
    fs.access(binPath).then(() => true).catch(() => false)
  ])
  return jsonExists && binExists
}

let activeVersionDir = DEFAULT_DIR

export async function downloadEmbeddings() {
  const versionInfo = await resolveBestVersion()
  if (!versionInfo) throw new Error('No suitable embeddings version found for cds@' + cds.version)

  activeVersionDir = versionInfo.localDir
  if (versionInfo.cached) return { updated: false, version: versionInfo.version }

  const jsonResponse = await fetch(`${versionInfo.versionUrl}/code-chunks.json`)
  if (!jsonResponse.ok) throw new Error(`Failed to download JSON: ${jsonResponse.status} ${jsonResponse.statusText}`)
  const jsonData = await jsonResponse.arrayBuffer()

  const binResponse = await fetch(`${versionInfo.versionUrl}/code-chunks.bin`)
  if (!binResponse.ok) throw new Error(`Failed to download BIN: ${binResponse.status} ${binResponse.statusText}`)
  const binData = await binResponse.arrayBuffer()

  await fs.mkdir(versionInfo.localDir, { recursive: true })
  const jsonPath = path.join(versionInfo.localDir, 'code-chunks.json')
  const binPath = path.join(versionInfo.localDir, 'code-chunks.bin')
  const tempJsonPath = jsonPath + '.tmp'
  const tempBinPath = binPath + '.tmp'

  try {
    await fs.writeFile(tempJsonPath, Buffer.from(jsonData))
    await fs.writeFile(tempBinPath, Buffer.from(binData))
    await fs.rename(tempJsonPath, jsonPath)
    await fs.rename(tempBinPath, binPath)
  } catch (writeError) {
    await fs.unlink(tempJsonPath).catch(() => {})
    await fs.unlink(tempBinPath).catch(() => {})
    throw writeError
  }

  return { updated: true, version: versionInfo.version }
}

const offline = process.argv.includes('--offline') || process.env.CDS_MCP_OFFLINE === 'true'

let downloadPromise = offline ? null : downloadEmbeddings()

export function formatResult(r) {
  if (!r.meta) return r.content
  const header = Object.entries(r.meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return header ? `${header}\n\n${r.content}` : r.content
}

export default async function searchMarkdownDocs(query, maxResults = 10) {
  if (downloadPromise) await downloadPromise

  async function searchWithRetry(retryCount = 0) {
    try {
      const chunks = await loadChunks('code-chunks', activeVersionDir)
      const results = (await searchEmbeddings(query, chunks)).slice(0, maxResults)
      return results.map(formatResult).join('\n---\n')
    } catch (error) {
      if (error.code === 'EMBEDDINGS_CORRUPTED' && retryCount < 2) {
        if (offline) throw error
        downloadPromise = downloadEmbeddings()
        await downloadPromise
        return searchWithRetry(retryCount + 1)
      }

      throw error
    }
  }

  return searchWithRetry()
}
