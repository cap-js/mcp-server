import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Loads the tokenizer for `modelId` from the local model cache and returns
 * a synchronous `measure` function (token count) and the content `maxTokens`
 * budget (tokens available after subtracting special-token overhead).
 *
 * If the model is not yet installed, downloads it first then retries.
 * Throws when `modelId` is missing.
 */
export async function createTokenMeasure(modelId) {
  if (!modelId) throw new Error('createTokenMeasure: modelId is required')

  // Load heavy deps lazily so importing this module stays cheap.
  const { fileForRole, loadTokenizerPackage } =
    await import('@cap-js/ai/lib/vector_embedding/model-utils.js')
  const { createTokenizerState, resolveEmbeddingModel } =
    await import('@cap-js/ai/lib/vector_embedding/embedding.js')
  const { MODEL_CACHE_ROOT } = await import('../../calculateEmbeddings.js')
  const { default: cds } = await import('@sap/cds')

  // Use the same configuration and caller root as AISQLiteService inference.
  const { model: lock, modelDir } = await resolveEmbeddingModel(
    { model: modelId, root: MODEL_CACHE_ROOT },
    { root: cds.root }
  )

  const { Tokenizer } = await loadTokenizerPackage()
  const tokenizerFile = fileForRole(lock, 'tokenizer')
  const tokenizerConfigFile = fileForRole(lock, 'tokenizerConfig')
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readFile(path.join(modelDir, tokenizerFile.name), 'utf-8').then(JSON.parse),
    readFile(path.join(modelDir, tokenizerConfigFile.name), 'utf-8').then(JSON.parse)
  ])
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig)
  const measure = (text) => tokenizer.encode(text, { add_special_tokens: false }).ids.length
  const { maxLength, prefix, suffix } = createTokenizerState(tokenizer, lock.maxLength)
  const maxTokens =
    maxLength - prefix.ids.length - suffix.ids.length - measure(lock.prompts?.document ?? '')
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new Error(`Model ${modelId} leaves no token budget for content`)
  }
  return { measure, maxTokens }
}
