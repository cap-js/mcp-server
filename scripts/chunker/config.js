export const DEFAULT_CONFIG = {
  maxHeadingDepth: 4,
  maxChunkSize: 512 * 3, // xenova/all-MiniLM-L6-v2 truncates at 256 word-piece tokens; ~3 chars/token → 1536 chars
  minChunkSize: 50,
  input: 'llms-full.txt',
  output: 'public/embeddings/code-chunks.json',
};

export function mergeConfig(overrides = {}) {
  const merged = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      merged[key] = Number(value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
