export const DEFAULT_MODEL = 'BAAI/bge-small-en-v1.5'

// Load the CDS-dependent generator only when embedding generation is requested.
export async function createCapireEmbeddings(chunkingConfig, embeddingConfig = {}) {
  const { generate, resolveConfig } = await import('./capireEmbeddings/createCapireEmbeddings.js')
  const config = await resolveConfig(chunkingConfig, embeddingConfig)
  return generate(config.chunkingConfig, config.embeddingConfig)
}
