// remapFs() creates a tmp dir and intercepts fs/promises, remapping paths
// that fall under DEFAULT_DIR into tmpRoot. All other paths (e.g. .cds/models/)
// pass through to the real disk unchanged. Returns tmpRoot so tests can write
// seed files directly with fsp.writeFile.

import { mock, after } from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DEFAULT_DIR } from '../../lib/calculateEmbeddings.js'

const require = createRequire(import.meta.url)
// Same object the source holds via `import fsp from 'fs/promises'`.
const fsp = require('fs/promises')

export function remapFs() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mcp-test-'))

  after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} })

  const remap = p => path.join(tmpRoot, path.resolve(String(p)).slice(1))

  function read(p, fn) {
    const resolved = path.resolve(String(p))
    return resolved.startsWith(DEFAULT_DIR) ? fn(remap(p)) : fn(resolved)
  }

  const orig = {}
  const methods = ['readFile', 'writeFile', 'mkdir', 'unlink', 'rename', 'access', 'stat', 'readdir', 'mkdtemp']
  for (const m of methods) orig[m] = fsp[m].bind(fsp)

  const impl = {
    readFile: (p, opts) => read(p, m => orig.readFile(m, opts)),
    access:   (p, mode) => read(p, m => orig.access(m, mode)),
    stat:     (p, opts) => read(p, m => orig.stat(m, opts)),
    readdir:  (p, opts) => read(p, m => orig.readdir(m, opts)),

    async writeFile(p, data, opts) {
      const mapped = remap(p)
      await orig.mkdir(path.dirname(mapped), { recursive: true })
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
    mock.method(fsp, name, impl[name])
  }

  return tmpRoot
}
