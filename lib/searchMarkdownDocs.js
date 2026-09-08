import { loadChunks, searchEmbeddings } from './embeddings.js'
import { DEFAULT_DIR, DEFAULT_EMBEDDINGS_DIR, DEFAULT_EMBEDDINGS_URL, MODEL_FOLDER } from './calculateEmbeddings.js'
import fs from 'fs/promises'
import path from 'path'
import cds from '@sap/cds'
import semver from 'semver'

const manifestEtagPath = path.join(DEFAULT_DIR, 'manifest.etag')

function getBundleUrl() {
  const base = DEFAULT_EMBEDDINGS_URL.replace(/\/[^/]+$/, '')
  const params = new URLSearchParams({ cds: cds.version, model: MODEL_FOLDER })
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

let activeVersionDir = DEFAULT_EMBEDDINGS_DIR

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
    activeVersionDir = local.localDir
    return { updated: false, version: local.version }
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

  activeVersionDir = localDir
  return { updated: true, version }
}

const offline = process.argv.includes('--offline') || process.env.CDS_MCP_OFFLINE === 'true'

async function offlineSetup() {
  const local = await resolveLocalVersion()
  if (!local) throw new Error('Offline mode: no local embeddings version found under ' + DEFAULT_EMBEDDINGS_DIR)
  activeVersionDir = local.localDir
  return { updated: false, version: local.version, offline: true }
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
