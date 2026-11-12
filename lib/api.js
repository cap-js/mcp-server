export const DEFAULT_MODEL = 'BAAI/bge-small-en-v1.5'

// Load the CDS-dependent generator only when embedding generation is requested.
export async function createCapireEmbeddings(chunkingConfig, embeddingConfig = {}) {
  const batch = Array.isArray(embeddingConfig.model)
  const models = batch ? embeddingConfig.model : [embeddingConfig.model]
  if (
    batch &&
    (!models.length || models.some((model) => typeof model !== 'string' || !model.trim()))
  )
    throw new Error('model must be a non-empty array of model names')
  const { generate, resolveConfig } = await import('./capireEmbeddings/createCapireEmbeddings.js')
  const results = []
  let sharedInput = chunkingConfig
  for (const model of models) {
    const config = await resolveConfig(sharedInput, { ...embeddingConfig, model })
    // Read or fetch documentation once, but initialize each model's tokenizer separately.
    sharedInput = { ...chunkingConfig, input: undefined, text: config.chunkingConfig.text }
    results.push(await generate(config.chunkingConfig, config.embeddingConfig))
  }
  return batch ? results : results[0]
}
