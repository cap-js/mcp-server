import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEmbeddingModel } from '@cap-js/ai/lib/vector_embedding/embedding.js'
import { getModelDirectory } from '@cap-js/ai/lib/vector_embedding/model-utils.js'

export const LOCAL_MODEL_CACHE_DIR = fileURLToPath(new URL('../.cds/models', import.meta.url))
export const MODEL_CACHE_DIR = path.join(os.homedir(), '.cds', 'models')

export async function resolveModelCache(model, {
  localRoot = LOCAL_MODEL_CACHE_DIR,
  home = os.homedir(),
  resolve = resolveEmbeddingModel,
  lstat = fs.lstat
} = {}) {
  const localDir = getModelDirectory(localRoot, model)
  let localExists = true
  try {
    await lstat(localDir)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    localExists = false
  }

  // Package-local models are explicit, read-only overrides; never trust the caller's project.
  if (localExists) {
    await resolve({ model, directory: localRoot })
    return localRoot
  }

  // The implicit resolver owns on-demand installation and repair, confined to the user's cache.
  await resolve({ model }, { root: home, home })
  return path.join(home, '.cds', 'models')
}
