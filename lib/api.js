export const DEFAULT_MODEL = 'BAAI/bge-small-en-v1.5'

// Load the CDS-dependent generator only when embedding generation is requested.
export async function generate(chunkingConfig, embeddingConfig, overrides) {
  const { generate: generateEmbeddings } =
    await import('./capireEmbeddings/createCapireEmbeddings.js')
  return generateEmbeddings(chunkingConfig, embeddingConfig, overrides)
}
