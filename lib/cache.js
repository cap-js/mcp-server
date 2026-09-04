import os from 'os'
import path from 'path'

function defaultCacheRoot() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches')
  }
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
}

export const CACHE_DIR = path.resolve(process.env.CDS_MCP_CACHE_DIR || path.join(defaultCacheRoot(), 'cds-mcp'))
export const MODEL_DIR = path.join(CACHE_DIR, 'models')
