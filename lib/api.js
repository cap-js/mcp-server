export const DEFAULT_MODEL = 'BAAI/bge-small-en-v1.5'

// Load the CDS-dependent generator only when embedding generation is requested.
export async function createMarkdownEmbeddings(chunkingConfig, embeddingConfig, overrides) {
  const { default: generate } = await import('./markdownEmbeddings/createMarkdownEmbeddings.js')
  return generate(chunkingConfig, embeddingConfig, overrides)
}
