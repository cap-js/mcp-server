import fs from 'fs/promises'
import { constants } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as ort from 'onnxruntime-web'

ort.env.debug = false
ort.env.logLevel = 'error'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2'
const MODEL_DIR = path.resolve(__dirname, '..', 'models')

const FILES = ['onnx/model.onnx', 'tokenizer.json', 'tokenizer_config.json']

async function saveFile(buffer, outputPath) {
  await fs.writeFile(outputPath, Buffer.from(buffer))
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function downloadFile(url, outputPath) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download ${url}, status ${res.status}`)

  if (url.endsWith('.onnx')) {
    const arrayBuffer = await res.arrayBuffer()
    await saveFile(arrayBuffer, outputPath)
  } else if (url.endsWith('.json')) {
    const json = await res.json()
    await saveFile(JSON.stringify(json, null, 2), outputPath)
  } else {
    const text = await res.text()
    await saveFile(text, outputPath)
  }
}

async function downloadModelIfNeeded() {
  try {
    await fs.access(MODEL_DIR)
  } catch {
    await fs.mkdir(MODEL_DIR, { recursive: true })
  }

  for (const file of FILES) {
    const filePath = path.join(MODEL_DIR, path.basename(file))
    if (!(await fileExists(filePath))) {
      const url = `https://huggingface.co/${MODEL_NAME}/resolve/main/${file}`
      await downloadFile(url, filePath)
    }
  }
}

async function forceRedownloadModel() {
  // Reset session and vocab to force reinitialization
  session = null
  vocab = null

  // Delete all model files to force re-download
  for (const file of FILES) {
    const filePath = path.join(MODEL_DIR, path.basename(file))
    if (await fileExists(filePath)) {
      await fs.unlink(filePath).catch(() => {})
    }
  }

  // Force re-download
  await downloadModelIfNeeded()
}

async function initializeModelAndVocab() {
  const modelPath = path.join(MODEL_DIR, 'model.onnx')
  const vocabPath = path.join(MODEL_DIR, 'tokenizer.json')

  const loadModelAndVocab = async () => {
    // Load model as buffer for onnxruntime-web
    const modelBuffer = await fs.readFile(modelPath)
    session = await ort.InferenceSession.create(modelBuffer)

    // Try to parse tokenizer JSON
    const tokenizerJson = JSON.parse(await fs.readFile(vocabPath, 'utf-8'))

    // Validate tokenizer structure
    if (!tokenizerJson.model || !tokenizerJson.model.vocab) {
      throw new Error('Invalid tokenizer structure: missing model.vocab')
    }

    vocab = tokenizerJson.model.vocab

    // Convert to clean Map to avoid prototype pollution
    const cleanVocab = new Map()
    for (const [token, id] of Object.entries(vocab)) {
      if (typeof id === 'number') {
        cleanVocab.set(token, id)
      }
    }
    vocab = cleanVocab
  }

  try {
    await loadModelAndVocab()
  } catch {
    // Model or tokenizer is corrupted, force re-download
    await forceRedownloadModel()

    // Retry initialization after re-download
    try {
      await loadModelAndVocab()
    } catch {
      throw new Error('Failed to restore valid tokenizer after re-download')
    }
  }
}

/**
 * Proper WordPiece tokenizer that closely matches HuggingFace BERT behavior:
 * - BERT-style pre-tokenization (handle punctuation properly)
 * - True WordPiece algorithm with greedy longest-match
 * - Proper Unicode normalization and lowercasing
 * - Special token handling
 */

/**
 * Basic text normalization similar to BERT
 */
function normalizeText(text) {
  // Convert to NFD normalization (decomposed)
  if (!text) return ''
  text = text.normalize('NFD')

  // Remove control characters except whitespace
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim()

  return text
}

/**
 * BERT-style punctuation detection
 */
function isPunctuation(char) {
  const cp = char.codePointAt(0)

  // ASCII punctuation
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
    return true
  }

  // Unicode punctuation categories
  const unicodeCat = getUnicodeCategory(char)
  return unicodeCat && /^P[cdfipeos]$/.test(unicodeCat)
}

/**
 * Simple Unicode category detection (basic implementation)
 */
function getUnicodeCategory(char) {
  // This is a simplified version - real BERT uses full Unicode database
  // For most common cases, we can use JavaScript's built-in properties
  if (/\p{P}/u.test(char)) return 'P' // Punctuation
  if (/\p{N}/u.test(char)) return 'N' // Number
  if (/\p{L}/u.test(char)) return 'L' // Letter
  if (/\p{M}/u.test(char)) return 'M' // Mark
  if (/\p{S}/u.test(char)) return 'S' // Symbol
  if (/\p{Z}/u.test(char)) return 'Z' // Separator
  return null
}

/**
 * BERT-style pre-tokenization: split on whitespace and punctuation
 */
function preTokenize(text) {
  const tokens = []
  let currentToken = ''

  for (const char of text) {
    if (/\s/.test(char)) {
      // Whitespace - finish current token
      if (currentToken) {
        tokens.push(currentToken)
        currentToken = ''
      }
    } else if (isPunctuation(char)) {
      // Punctuation - finish current token and add punctuation as separate token
      if (currentToken) {
        tokens.push(currentToken)
        currentToken = ''
      }
      tokens.push(char)
    } else {
      // Regular character - add to current token
      currentToken += char
    }
  }

  // Add final token if any
  if (currentToken) {
    tokens.push(currentToken)
  }

  return tokens.filter(token => token.length > 0)
}

/**
 * True WordPiece tokenization with greedy longest-match algorithm
 */
function wordPieceTokenize(token, vocab, unkToken = '[UNK]', maxInputCharsPerWord = 200) {
  if (token.length > maxInputCharsPerWord) {
    return [unkToken]
  }

  const outputTokens = []
  let start = 0

  while (start < token.length) {
    let end = token.length
    let currentSubstring = null

    // Greedy longest-match: try longest possible substring first
    while (start < end) {
      let substring = token.substring(start, end)

      // Add ## prefix for continuation tokens (not at word start)
      if (start > 0) {
        substring = '##' + substring
      }

      if (vocab.has(substring)) {
        currentSubstring = substring
        break
      }
      end -= 1
    }

    if (currentSubstring === null) {
      // No valid substring found, mark as unknown
      return [unkToken]
    }

    outputTokens.push(currentSubstring)
    start = end
  }

  return outputTokens
}

/**
 * Main tokenization function that combines all steps
 */
function wordPieceTokenizer(text, vocab, maxLength = 512) {
  const unkToken = '[UNK]'
  const clsToken = '[CLS]'
  const sepToken = '[SEP]'

  // Get special token IDs using Map interface
  const clsId = vocab.get(clsToken) ?? 101
  const sepId = vocab.get(sepToken) ?? 102
  const unkId = vocab.get(unkToken) ?? 100

  // Validate special token IDs
  if (typeof clsId !== 'number' || typeof sepId !== 'number' || typeof unkId !== 'number') {
    throw new Error('Special tokens must have numeric IDs')
  }

  // Step 1: Normalize text
  const normalizedText = normalizeText(text)

  // Step 2: Pre-tokenization (split on whitespace and punctuation)
  const preTokens = preTokenize(normalizedText)

  // Step 3: WordPiece tokenization
  const tokens = [clsToken]
  const ids = [clsId]

  for (const preToken of preTokens) {
    // Convert to lowercase for BERT
    const lowercaseToken = preToken.toLowerCase()

    // Apply WordPiece algorithm
    const wordPieceTokens = wordPieceTokenize(lowercaseToken, vocab, unkToken)

    for (const wpToken of wordPieceTokens) {
      const tokenId = vocab.get(wpToken) ?? unkId
      tokens.push(wpToken)
      ids.push(tokenId)
    }
  }

  // Add SEP token
  tokens.push(sepToken)
  ids.push(sepId)

  // Handle length constraints with chunking
  if (tokens.length <= maxLength) {
    return [{ tokens, ids }]
  }

  // For longer texts, create overlapping chunks
  const maxContentLength = maxLength - 2 // Reserve space for [CLS] and [SEP]
  const overlap = Math.floor(maxContentLength * 0.1) // 10% overlap
  const chunkSize = maxContentLength - overlap

  const chunks = []
  const contentTokens = tokens.slice(1, -1) // Remove [CLS] and [SEP]
  const contentIds = ids.slice(1, -1)

  for (let i = 0; i < contentTokens.length; i += chunkSize) {
    const chunkTokens = [clsToken, ...contentTokens.slice(i, i + maxContentLength - 1), sepToken]
    const chunkIds = [clsId, ...contentIds.slice(i, i + maxContentLength - 1), sepId]

    chunks.push({
      tokens: chunkTokens,
      ids: chunkIds
    })
  }

  return chunks
}

let session = null
let vocab = null

// Start downloading and initializing model when module loads
const modelInitPromise = (async () => {
  try {
    await downloadModelIfNeeded()
    await initializeModelAndVocab()
  } catch {
    // Don't throw here - let the main function handle initialization
  }
})()

export function resetSession() {
  session = null
  vocab = null
}

/**
 * Process multiple texts in a single batch inference call
 */
async function processBatchEmbeddings(batchTokenData, session) {
  const { inputIds, attentionMask, tokenTypeIds, batchSize, maxSeqLength, hiddenSize } = batchTokenData

  const inputTensor = new ort.Tensor('int64', inputIds, [batchSize, maxSeqLength])
  const attentionTensor = new ort.Tensor('int64', attentionMask, [batchSize, maxSeqLength])
  const tokenTypeTensor = new ort.Tensor('int64', tokenTypeIds, [batchSize, maxSeqLength])

  const feeds = {
    input_ids: inputTensor,
    attention_mask: attentionTensor,
    token_type_ids: tokenTypeTensor
  }

  const results = await session.run(feeds)
  const lastHiddenState = results['last_hidden_state']
  const embeddingData = lastHiddenState.data

  // Extract embeddings for each item in batch
  const embeddings = []
  for (let batchIdx = 0; batchIdx < batchSize; batchIdx++) {
    const pooledEmbedding = new Float32Array(hiddenSize)

    // Calculate valid sequence length for this batch item (excluding padding)
    let validSeqLength = 0
    for (let seqIdx = 0; seqIdx < maxSeqLength; seqIdx++) {
      if (attentionMask[batchIdx * maxSeqLength + seqIdx] === BigInt(1)) {
        validSeqLength++
      }
    }

    // Apply mean pooling across the valid sequence dimension
    for (let hiddenIdx = 0; hiddenIdx < hiddenSize; hiddenIdx++) {
      let sum = 0
      for (let seqIdx = 0; seqIdx < validSeqLength; seqIdx++) {
        const dataIdx = batchIdx * maxSeqLength * hiddenSize + seqIdx * hiddenSize + hiddenIdx
        sum += embeddingData[dataIdx]
      }
      pooledEmbedding[hiddenIdx] = sum / validSeqLength
    }

    embeddings.push(pooledEmbedding)
  }

  return embeddings
}

/**
 * Prepare batch data for inference - handles padding and creates tensors
 */
function prepareBatchTokenData(allChunks) {
  // Find the maximum sequence length across all chunks
  let maxSeqLength = 0
  for (const chunks of allChunks) {
    for (const chunk of chunks) {
      maxSeqLength = Math.max(maxSeqLength, chunk.ids.length)
    }
  }

  const batchSize = allChunks.length
  const hiddenSize = 384 // MiniLM-L6-v2 hidden size

  // Pre-allocate arrays for batch data
  const inputIds = new BigInt64Array(batchSize * maxSeqLength)
  const attentionMask = new BigInt64Array(batchSize * maxSeqLength)
  const tokenTypeIds = new BigInt64Array(batchSize * maxSeqLength)

  // Fill batch data
  for (let batchIdx = 0; batchIdx < batchSize; batchIdx++) {
    const chunks = allChunks[batchIdx]

    // For now, just use the first chunk (most texts will be single chunk)
    // TODO: Handle multi-chunk texts properly
    const chunk = chunks[0]
    const ids = chunk.ids

    const baseOffset = batchIdx * maxSeqLength

    // Fill actual token data
    for (let seqIdx = 0; seqIdx < ids.length && seqIdx < maxSeqLength; seqIdx++) {
      const id = ids[seqIdx]
      if (typeof id !== 'number' || isNaN(id) || !isFinite(id)) {
        throw new Error(`Invalid token ID: ${id}`)
      }

      inputIds[baseOffset + seqIdx] = BigInt(id)
      attentionMask[baseOffset + seqIdx] = BigInt(1)
      tokenTypeIds[baseOffset + seqIdx] = BigInt(0)
    }

    // Padding is already zero-filled (BigInt64Array defaults to 0)
    // Attention mask for padding positions remains 0
  }

  return {
    inputIds,
    attentionMask,
    tokenTypeIds,
    batchSize,
    maxSeqLength,
    hiddenSize
  }
}

/**
 * Batch processing function for multiple texts
 */
export async function calculateEmbeddingsBatch(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('Input must be a non-empty array of strings')
  }

  // Wait for the model to be preloaded, then ensure it's initialized
  await modelInitPromise

  if (!session || !vocab) {
    await initializeModelAndVocab()
  }

  // Tokenize all texts in parallel
  const allChunks = await Promise.all(texts.map(text => Promise.resolve(wordPieceTokenizer(text, vocab))))

  // Check for multi-chunk texts (not fully supported yet)
  const hasMultiChunk = allChunks.some(chunks => chunks.length > 1)
  if (hasMultiChunk) {
    // Fall back to individual processing for multi-chunk texts
    console.warn('Multi-chunk texts detected, falling back to individual processing')
    return Promise.all(texts.map(text => calculateEmbeddings(text)))
  }

  function normalizeEmbedding(embedding) {
    let norm = 0
    for (let i = 0; i < embedding.length; i++) {
      norm += embedding[i] * embedding[i]
    }
    norm = Math.sqrt(norm)

    const normalized = new Float32Array(embedding.length)
    for (let i = 0; i < embedding.length; i++) {
      normalized[i] = embedding[i] / norm
    }
    return normalized
  }

  try {
    const batchTokenData = prepareBatchTokenData(allChunks)
    const embeddings = await processBatchEmbeddings(batchTokenData, session)

    // Normalize all embeddings
    return embeddings.map(embedding => normalizeEmbedding(embedding))
  } catch (error) {
    // If inference fails, try to recover by re-downloading and reinitializing
    console.warn('Batch inference failed, attempting recovery:', error.message)

    await forceRedownloadModel()
    await initializeModelAndVocab()

    const batchTokenData = prepareBatchTokenData(allChunks)
    const retryEmbeddings = await processBatchEmbeddings(batchTokenData, session)
    return retryEmbeddings.map(embedding => normalizeEmbedding(embedding))
  }
}

export default async function calculateEmbeddings(text) {
  const result = await calculateEmbeddingsBatch([text])
  return result[0]
}
