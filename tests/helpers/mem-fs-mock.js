// Test filesystem helper built on node:test `mock.method`.
//
// installMemFs() creates a fresh tmp dir and intercepts fs/promises methods,
// remapping every path into the tmp dir so tests never touch the real disk.
// Reads outside the embeddings/ root fall back to the real disk when the
// file is not present in the tmp dir (so the embedder still loads its real
// model from .cds/models). Writes always go to the tmp dir.
//
// Teardown: mock.restoreAll() in afterEach/after (same as before).
// The tmp dir is removed automatically by a registered after() hook.

import { mock, after } from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DEFAULT_DIR } from '../../lib/calculateEmbeddings.js'

const require = createRequire(import.meta.url)
// Same object the source holds via `import fs from 'fs/promises'`.
const fsp = require('fs/promises')

const EMBEDDINGS_DIR = path.resolve(DEFAULT_DIR)

export function installMemFs() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mcp-test-'))
  const writes = new Map()
  const mocks = {}

  const cleanup = () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} }
  after(cleanup)

  function remap(p) {
    const abs = path.resolve(String(p))
    if (abs === EMBEDDINGS_DIR || abs.startsWith(EMBEDDINGS_DIR + path.sep)) {
      return path.join(tmpRoot, 'embeddings', path.relative(EMBEDDINGS_DIR, abs))
    }
    const rel = abs.startsWith(path.sep) ? abs.slice(1) : abs
    return path.join(tmpRoot, 'other', rel)
  }

  function isEmbeddings(p) {
    const abs = path.resolve(String(p))
    return abs === EMBEDDINGS_DIR || abs.startsWith(EMBEDDINGS_DIR + path.sep)
  }

  // Capture originals before replacing them.
  const orig = {}
  const methods = ['readFile', 'writeFile', 'mkdir', 'unlink', 'rename', 'access', 'stat', 'readdir', 'mkdtemp']
  for (const m of methods) orig[m] = fsp[m].bind(fsp)

  // Reads under embeddings/ use the tmp dir only. All other reads try the tmp
  // dir first and fall back to the real disk on ENOENT.
  async function read(p, fn) {
    const mapped = remap(p)
    if (isEmbeddings(p)) return fn(mapped)
    try { return await fn(mapped) } catch (e) {
      if (e.code === 'ENOENT') return fn(path.resolve(String(p)))
      throw e
    }
  }

  const impl = {
    readFile: (p, opts) => read(p, m => orig.readFile(m, opts)),
    access:   (p, mode) => read(p, m => orig.access(m, mode)),
    stat:     (p, opts) => read(p, m => orig.stat(m, opts)),
    readdir:  (p, opts) => read(p, m => orig.readdir(m, opts)),

    async writeFile(p, data, opts) {
      const mapped = remap(p)
      await orig.mkdir(path.dirname(mapped), { recursive: true })
      writes.set(path.resolve(String(p)), Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
      return orig.writeFile(mapped, data, opts)
    },

    mkdir:  (p, opts) => orig.mkdir(remap(p), opts),
    unlink: p => orig.unlink(remap(p)),

    async rename(from, to) {
      const mappedTo = remap(to)
      await orig.mkdir(path.dirname(mappedTo), { recursive: true })
      return orig.rename(remap(from), mappedTo)
    },

    async mkdtemp(prefix, opts) {
      const mapped = remap(prefix)
      await orig.mkdir(path.dirname(mapped), { recursive: true })
      return orig.mkdtemp(mapped, opts)
    }
  }

  for (const name of Object.keys(impl)) {
    mocks[name] = mock.method(fsp, name, impl[name])
  }

  function seedFile(p, content = '') {
    const mapped = remap(p)
    fs.mkdirSync(path.dirname(mapped), { recursive: true })
    fs.writeFileSync(mapped, Buffer.isBuffer(content) ? content : Buffer.from(String(content)))
  }

  const handle = {
    mocks,
    seedFile,
    exists:   p => fs.existsSync(remap(p)),
    readFile: (p, enc) => fs.readFileSync(remap(p), enc),
    readJson: p => JSON.parse(fs.readFileSync(remap(p), 'utf-8')),
    setMtime(p, t) { fs.utimesSync(remap(p), new Date(t), new Date(t)) },
    writtenJson(suffix = '.json') {
      for (const [k, data] of writes) {
        if (k.endsWith(suffix)) return JSON.parse(data.toString('utf-8'))
      }
    }
  }

  return handle
}
