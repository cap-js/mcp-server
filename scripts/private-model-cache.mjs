import assert from 'node:assert/strict'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const cacheHome = process.env.CDS_MCP_TEST_CACHE_HOME
assert.ok(cacheHome && path.isAbsolute(cacheHome), 'The smoke test needs a private cache home')

// Keep home-cache downloads private to the check, including named imports of homedir.
os.homedir = () => cacheHome
syncBuiltinESMExports()
