export const MODEL_CONFIG = {
  // Custom install descriptor for models @cap-js/ai cannot discover on its own.
  // Used by `npm run install-model` when model === modelLock.repository.
  modelLock: {
    formatVersion: 2,
    repository: 'perplexity-ai/pplx-embed-v1-0.6b',
    revision: '2c4d510dd4a732063c31a0f70193e35067b51fd8',
    dimensions: 1024,
    maxLength: 32768,
    files: [
      {
        role: 'model',
        name: 'model.onnx',
        path: 'onnx/model.onnx',
        size: 520292,
        sha256: '06449e3c1566f9bb2e84eef6c7b533d8ee69f5d87a303d7105ead5b343e0608e'
      },
      {
        role: 'auxiliary',
        name: 'model.onnx_data',
        path: 'onnx/model.onnx_data',
        size: 2094723072,
        sha256: '8311b0b59f197527388c376017d4c41f484487e0b25e6507aa6f1c84c7a0b2b7'
      },
      {
        role: 'auxiliary',
        name: 'model.onnx_data_1',
        path: 'onnx/model.onnx_data_1',
        size: 306225152,
        sha256: 'ca448326b2c590934e0735faef433092801d7d45904e0ce67920218683b20cf2'
      },
      {
        role: 'tokenizer',
        name: 'tokenizer.json',
        path: 'tokenizer.json',
        size: 11422837,
        sha256: 'c6fb5c5bbba5fa5f8332edfb6d8aa67bd7fb3d75365b1765f108201698eaebf5'
      },
      {
        role: 'tokenizerConfig',
        name: 'tokenizer_config.json',
        path: 'tokenizer_config.json',
        size: 5638,
        sha256: '29282daeff3615d49f86c9e6c6fefb3a798a516da39f9297f3fcb2a8b39e0180'
      },
      {
        role: 'auxiliary',
        name: 'config.json',
        path: 'config.json',
        size: 1782,
        sha256: 'f7865547ecc1c077c5b1f83913fb9816a6586c676ccf3e0f7f00105a1b0c1c6c'
      }
    ],
    output: {
      name: 'last_hidden_state',
      pooling: 'mean',
      normalize: false,
      includePrompt: true
    }
  }
};

export const DEFAULT_CONFIG = {
  maxHeadingDepth: 4,
  maxChunkSize: 512 * 3, // xenova/all-MiniLM-L6-v2 truncates at 256 word-piece tokens; ~3 chars/token → 1536 chars
  minChunkSize: 50,
  input: 'llms-full.txt',
  output: 'public/embeddings/code-chunks.json',
  model: 'perplexity-ai/pplx-embed-v1-0.6b' // pplx: perplexity-ai/pplx-embed-v1-0.6b
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

export function parseArgs(argv) {
  const overrides = {};
  let input = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--max-chunk-size':    overrides.maxChunkSize = argv[++i];    break;
      case '--min-chunk-size':    overrides.minChunkSize = argv[++i];    break;
      case '--max-heading-depth': overrides.maxHeadingDepth = argv[++i]; break;
      case '--output':            overrides.output = argv[++i];          break;
      case '--model':             overrides.model = argv[++i];           break;
      default: input = arg; break;
    }
  }

  const config = mergeConfig(overrides);
  if (input) config.input = input;
  return config;
}
