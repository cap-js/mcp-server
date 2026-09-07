import { existsSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The cds-dbs git repo is a monorepo whose root package is @cap-js/db-services.
// npm cannot install git subdirectories as named packages, so we install the whole
// monorepo under the alias @cap-js/db-service and symlink the workspace subpackages
// into node_modules/@cap-js/. This mirrors what npm workspaces do.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const monorepo = resolve(root, 'node_modules/@cap-js/db-service')

const links = [
  { target: resolve(monorepo, 'db-service'), linkPath: resolve(root, 'node_modules/@cap-js/db-service') },
  { target: resolve(monorepo, 'sqlite'),     linkPath: resolve(root, 'node_modules/@cap-js/sqlite') },
]

// db-service workspace must shadow the monorepo root — use a nested node_modules entry
// so that requires from within the monorepo folder resolve correctly
const innerLink = {
  target: resolve(monorepo, 'db-service'),
  linkPath: resolve(monorepo, 'node_modules/@cap-js/db-service'),
}

for (const { target, linkPath } of [...links.slice(1), innerLink]) {
  if (!existsSync(target)) {
    console.error(`[linkSqlite] missing ${target} — is @cap-js/db-service installed?`)
    process.exit(1)
  }
  mkdirSync(dirname(linkPath), { recursive: true })
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(target, linkPath, 'dir')
  console.log(`[linkSqlite] ${linkPath} -> ${target}`)
}