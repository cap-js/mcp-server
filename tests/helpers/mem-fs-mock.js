// General in-memory filesystem for tests, built on node:test `mock.method`.
//
// Rule: tests must never create, edit, or remove real files. Reading a real
// committed fixture (for example the ML model) is fine. So:
//
//   - WRITES (writeFile, mkdir, unlink, rename, mkdtemp) always go to the
//     in-memory store. The real disk is never touched.
//   - READS (readFile, stat, access, readdir) serve from the store first,
//     then fall through to the REAL disk — EXCEPT under a "mocked root" (by
//     default the project's `embeddings/` dir), which stays a clean in-memory
//     slate: an unseeded read there rejects ENOENT instead of leaking the real
//     bundle/etag. This is what the embeddings-logic tests need, and it lets the
//     embedder still load its real model from `.cds/models`.
//
// Only the methods the code and tests actually use are mocked.
//
// Teardown is the suite's usual `mock.restoreAll()` in an afterEach/after hook.
//
// Only the promises API is mocked. `import fs from 'fs/promises'` and
// `import fs from 'node:fs'` then `fs.promises.*` resolve to the ONE object
// returned by require('fs/promises'), so one set of stubs covers them.
// Destructured named imports capture the function at import time and are NOT
// reachable here — those code paths stay out of scope.

import { mock } from 'node:test'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import cds from '@sap/cds'
import calculateEmbeddings, { DEFAULT_DIR, getActiveModelFolder } from '../../lib/calculateEmbeddings.js'

const require = createRequire(import.meta.url)
// Same object the source holds via `import fs from 'fs/promises'`.
const fsp = require('fs/promises')

function fsError(code, errno, syscall, p) {
  return Object.assign(new Error(`${code}: ${syscall} '${p}'`), {
    code,
    errno,
    syscall,
    path: p
  })
}
const enoent = (syscall, p) => fsError('ENOENT', -2, syscall, p)
const enotdir = (syscall, p) => fsError('ENOTDIR', -20, syscall, p)

// mockedRoots default to the embeddings dir — the one tree we keep fully virtual.
export function installMemFs({ seed, mockedRoots = [DEFAULT_DIR] } = {}) {
  const store = new Map() // normalized absolute path -> node
  const tombstones = new Set() // paths deleted in memory (hide a real file)
  let clock = 1 // monotonic mtime source
  const writes = new Map() // path -> Buffer, written since install
  const mocks = {} // method name -> node:test Mock (for call-arg assertions)
  const real = {} // real implementations, captured before replacement
  const roots = mockedRoots.map(r => path.resolve(r))

  const norm = p => path.resolve(String(p))
  const now = () => clock++
  const isMocked = key => roots.some(r => key === r || key.startsWith(r + path.sep))

  function ensureDir(dir) {
    const key = norm(dir)
    tombstones.delete(key)
    if (store.get(key)?.type === 'dir') return
    const parent = path.dirname(key)
    if (parent !== key) ensureDir(parent)
    store.set(key, { type: 'dir', mtimeMs: now(), birthtimeMs: now() })
  }

  function setFile(p, data) {
    const key = norm(p)
    tombstones.delete(key)
    ensureDir(path.dirname(key))
    const content = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data))
    store.set(key, {
      type: 'file',
      content,
      mtimeMs: now(),
      birthtimeMs: now()
    })
    return key
  }

  function memChildren(dir) {
    const key = norm(dir)
    const out = []
    for (const k of store.keys()) {
      if (k === key) continue
      if (path.dirname(k) === key) out.push(k)
    }
    return out
  }

  function statLike(node) {
    return {
      isDirectory: () => node.type === 'dir',
      isFile: () => node.type === 'file',
      isSymbolicLink: () => false,
      size: node.content ? node.content.length : 0,
      mtimeMs: node.mtimeMs,
      mtime: new Date(node.mtimeMs),
      birthtimeMs: node.birthtimeMs ?? node.mtimeMs
    }
  }

  function dirent(name, node) {
    return {
      name,
      isDirectory: () => node.type === 'dir',
      isFile: () => node.type === 'file',
      isSymbolicLink: () => false
    }
  }

  // A read miss: ENOENT inside a mocked root or if tombstoned, else real fs.
  const readThrough = (key, p, realCall) => {
    if (tombstones.has(key) || isMocked(key)) throw enoent(realCall.syscall, key)
    return realCall.fn(p)
  }

  const impl = {
    async readFile(p, options) {
      const key = norm(p)
      const node = store.get(key)
      if (node?.type === 'file') {
        const encoding = typeof options === 'string' ? options : options?.encoding
        return encoding ? node.content.toString(encoding) : Buffer.from(node.content)
      }
      if (node) throw enoent('open', key) // a dir
      return readThrough(key, p, {
        syscall: 'open',
        fn: x => real.readFile(x, options)
      })
    },

    async writeFile(p, data) {
      const key = setFile(p, data)
      writes.set(key, store.get(key).content)
    },

    async mkdir(p, options) {
      const key = norm(p)
      if (store.has(key)) {
        if (options?.recursive) return undefined
        throw fsError('EEXIST', -17, 'mkdir', key)
      }
      if (options?.recursive) ensureDir(key)
      else {
        const parent = path.dirname(key)
        if (store.get(parent)?.type !== 'dir') throw enoent('mkdir', key)
        tombstones.delete(key)
        store.set(key, { type: 'dir', mtimeMs: now(), birthtimeMs: now() })
      }
      return undefined
    },

    async unlink(p) {
      const key = norm(p)
      const node = store.get(key)
      store.delete(key)
      tombstones.add(key)
      if (!node && isMocked(key)) throw enoent('unlink', key)
      return undefined
    },

    async rename(from, to) {
      const fromKey = norm(from)
      const toKey = norm(to)
      if (!store.has(fromKey)) throw enoent('rename', fromKey)
      ensureDir(path.dirname(toKey))
      const move = (src, dst) => {
        const n = store.get(src)
        store.delete(src)
        n.mtimeMs = now()
        store.set(dst, n)
        tombstones.delete(dst)
      }
      const prefix = fromKey + path.sep
      for (const k of [...store.keys()]) {
        if (k.startsWith(prefix)) move(k, toKey + k.slice(fromKey.length))
      }
      move(fromKey, toKey)
      tombstones.add(fromKey)
      return undefined
    },

    async access(p) {
      const key = norm(p)
      if (store.has(key)) return undefined
      return readThrough(key, p, {
        syscall: 'access',
        fn: x => real.access(x)
      })
    },

    async stat(p) {
      const key = norm(p)
      const node = store.get(key)
      if (node) return statLike(node)
      return readThrough(key, p, { syscall: 'stat', fn: x => real.stat(x) })
    },

    async readdir(p, options) {
      const key = norm(p)
      const node = store.get(key)
      if (node && node.type !== 'dir') throw enotdir('scandir', key)
      const byName = new Map()
      if (node) {
        for (const k of memChildren(key)) byName.set(path.basename(k), dirent(path.basename(k), store.get(k)))
      }
      if (isMocked(key)) {
        if (!node) throw enoent('scandir', key)
      } else {
        try {
          const realEntries = await real.readdir(key, { withFileTypes: true })
          for (const d of realEntries) {
            if (byName.has(d.name)) continue
            if (tombstones.has(path.join(key, d.name))) continue
            byName.set(d.name, d)
          }
        } catch (err) {
          if (!node) throw err
        }
      }
      const entries = [...byName.values()]
      return options?.withFileTypes ? entries : entries.map(d => d.name)
    },

    async mkdtemp(prefix) {
      const dir = String(prefix) + randomUUID().replace(/-/g, '').slice(0, 6)
      ensureDir(dir)
      return dir
    }
  }

  for (const name of Object.keys(impl)) {
    real[name] = fsp[name].bind(fsp)
    mocks[name] = mock.method(fsp, name, impl[name])
  }

  const handle = {
    store,
    writes,
    mocks,
    seedDir(p) {
      ensureDir(p)
      return norm(p)
    },
    seedFile(p, content = '') {
      return setFile(p, content)
    },
    seedTree(tree) {
      for (const [p, content] of Object.entries(tree)) {
        if (content === null) handle.seedDir(p)
        else handle.seedFile(p, content)
      }
    },
    remove(p) {
      const key = norm(p)
      store.delete(key)
      tombstones.add(key)
    },
    exists(p) {
      return store.has(norm(p))
    },
    readFile(p, encoding) {
      const node = store.get(norm(p))
      if (!node || node.type !== 'file') return undefined
      return encoding ? node.content.toString(encoding) : Buffer.from(node.content)
    },
    readJson(p) {
      const raw = handle.readFile(norm(p), 'utf-8')
      return raw === undefined ? undefined : JSON.parse(raw)
    },
    mtime(p) {
      return store.get(norm(p))?.mtimeMs
    },
    setMtime(p, mtimeMs) {
      const node = store.get(norm(p))
      if (node) node.mtimeMs = mtimeMs
    },
    writtenJson(suffix = '.json') {
      for (const [k, data] of writes) {
        if (k.endsWith(suffix)) return JSON.parse(data.toString('utf-8'))
      }
      return undefined
    }
  }

  if (seed) handle.seedTree(seed)
  return handle
}

// --- Test bundle helpers -----------------------------------------------------
// Kept here so a test needs only this one helper.

// Fixed commit id the mock server reports for the test bundle.
export const TEST_COMMIT_ID = '__test_bundle__'

// Etag path for the ACTIVE model and the installed cds version. Tracks
// setActiveModel(); detectRuntime() resolves this project's cds version.
export function getManifestEtagPath() {
  return path.join(DEFAULT_DIR, getActiveModelFolder(), 'etags', cds.version, 'manifest.etag')
}

// Small CAP-relevant chunks covering the search assertions:
//   - 'cds init' for query 'how to create a new cap project'
//   - 'enterprise-messaging' for query 'event mesh config'
const TEST_CHUNKS = [
  'To create a new CAP project, run: cds init my-project. The cds init command scaffolds a minimal project.',
  'Use cds add hana to add HANA support. First run cds init to bootstrap the project structure.',
  'Enterprise messaging in CAP uses enterprise-messaging as the service binding kind in package.json under cds.requires.',
  'SAP Event Mesh (enterprise-messaging) enables async messaging between microservices in CAP applications.',
  'Define CDS entities: entity Books { key ID: Integer; title: String; author: Association to Authors; }',
  'Expose entities via services: service CatalogService { entity Books as projection on my.Books; }',
  'CQL SELECT statement syntax: SELECT from Books where title = :title order by title asc'
]

// Build the server's binary frame — [4-byte BE meta length][meta JSON][bin] —
// from real embeddings of TEST_CHUNKS. The embedder reads its real model; the
// frame needs no committed bundle, so this works on a clean CI checkout.
export async function buildTestBundle() {
  const vecs = await Promise.all(TEST_CHUNKS.map(chunk => calculateEmbeddings(chunk)))
  const dim = vecs[0].length
  const flat = new Float32Array(TEST_CHUNKS.length * dim)
  for (let i = 0; i < vecs.length; i++) flat.set(vecs[i], i * dim)
  const meta = { dim, count: TEST_CHUNKS.length, chunks: TEST_CHUNKS }
  const metaBuf = Buffer.from(JSON.stringify(meta))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(metaBuf.length, 0)
  return Buffer.concat([header, metaBuf, Buffer.from(flat.buffer)])
}
