#!/usr/bin/env node
import { createWriteStream, createReadStream } from 'node:fs'
import { mkdir, writeFile, lstat, unlink, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODEL_CONFIG, DEFAULT_CONFIG } from './chunker/config.js'

const HUB = 'https://huggingface.co'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL_ROOT = path.join(__dirname, '..', '.cds', 'models')

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function isValid(filePath, file) {
  try {
    const stat = await lstat(filePath)
    if (!stat.isFile() || stat.size !== file.size) return false
    process.stdout.write(`  verifying ${file.name}...`)
    const ok = (await sha256File(filePath)) === file.sha256
    process.stdout.write(ok ? ' ok\n' : ' mismatch\n')
    return ok
  } catch {
    return false
  }
}

async function download(lock, file, modelDir) {
  const url = `${HUB}/${lock.repository}/resolve/${lock.revision}/${file.path}`
  const dest = path.join(modelDir, file.name)
  const tmp = `${dest}.${process.pid}.tmp`

  const mb = (file.size / 1e6).toFixed(0)
  console.log(`  downloading ${file.name} (${mb} MB)...`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`)

  await pipeline(res.body, createWriteStream(tmp))

  const actual = await sha256File(tmp)
  if (actual !== file.sha256) {
    await unlink(tmp).catch(() => {})
    throw new Error(`sha256 mismatch for ${file.name}: expected ${file.sha256}, got ${actual}`)
  }

  await unlink(dest).catch(() => {})
  await rename(tmp, dest)
  console.log(`  ${file.name} done`)
}

export default async function installModel() {
  const { modelLock: lock } = MODEL_CONFIG
  const model = DEFAULT_CONFIG.model

  if (lock && model === lock.repository) {
    // Custom model with external data shards — install manually
    const modelDir = path.join(MODEL_ROOT, ...lock.repository.split('/'))
    await mkdir(modelDir, { recursive: true })

    for (const file of lock.files) {
      const dest = path.join(modelDir, file.name)
      if (await isValid(dest, file)) {
        console.log(`  ${file.name} already valid, skipping`)
        continue
      }
      await download(lock, file, modelDir)
    }

    const lockPath = path.join(modelDir, 'embedding.lock.json')
    await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n')
    console.log(`\nLock written to ${lockPath}`)
    console.log(`Model ready: ${lock.repository}`)
  } else {
    // Standard Sentence Transformers model — delegate to @cap-js/ai
    console.log(`Installing ${model} via @cap-js/ai...`)
    execFileSync('npx', ['@cap-js/ai', 'install-model', model], { stdio: 'inherit' })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  installModel().catch(err => { process.stderr.write(`${err.stack}\n`); process.exit(1) })
}
