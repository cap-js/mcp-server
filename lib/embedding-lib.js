import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as ort from 'onnxruntime-web'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2'
const MODEL_DIR = path.resolve(__dirname, '..', 'models')

const FILES = ['onnx/model.onnx', 'tokenizer.json', 'tokenizer_config.json']

function saveFile(buffer, outputPath) {
  return new Promise((resolve, reject) => {
    fs.writeFile(outputPath, Buffer.from(buffer), err => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath)
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
  if (!fs.existsSync(MODEL_DIR)) {
    fs.mkdirSync(MODEL_DIR, { recursive: true })
  }

  for (const file of FILES) {
    const filePath = path.join(MODEL_DIR, path.basename(file))
    if (!fileExists(filePath)) {
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
    try {
      if (fileExists(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch {
      // Ignore deletion errors, we'll overwrite anyway
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
    const modelBuffer = fs.readFileSync(modelPath)
    session = await ort.InferenceSession.create(modelBuffer)

    // Try to parse tokenizer JSON
    const tokenizerJson = JSON.parse(fs.readFileSync(vocabPath, 'utf-8'))

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
  } catch (error) {
    // Model or tokenizer is corrupted, force re-download
    // eslint-disable-next-line no-console
    console.warn('Model corruption detected, re-downloading...', error.message)
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
    // eslint-disable-next-line no-console
    console.error('Invalid special token IDs:', { clsId, sepId, unkId })
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

/**
 * Process embeddings for multiple chunks and combine them
 */
async function processChunkedEmbeddings(chunks, session) {
  const embeddings = []

  for (const chunk of chunks) {
    const { ids } = chunk

    // ONNX Runtime input tensors must be int64 (BigInt64Array)
    // Add validation for token IDs before converting to BigInt
    const validIds = ids.filter(id => {
      const isValid = typeof id === 'number' && !isNaN(id) && isFinite(id)
      if (!isValid) {
        // eslint-disable-next-line no-console
        console.warn(`Invalid token ID detected: ${id} (type: ${typeof id})`)
      }
      return isValid
    })

    if (validIds.length !== ids.length) {
      // eslint-disable-next-line no-console
      console.warn(`Filtered out ${ids.length - validIds.length} invalid token IDs`)
    }

    const inputIds = new BigInt64Array(validIds.map(i => BigInt(i)))
    const attentionMask = new BigInt64Array(validIds.length).fill(BigInt(1))
    const tokenTypeIds = new BigInt64Array(validIds.length).fill(BigInt(0))

    const inputTensor = new ort.Tensor('int64', inputIds, [1, validIds.length])
    const attentionTensor = new ort.Tensor('int64', attentionMask, [1, validIds.length])
    const tokenTypeTensor = new ort.Tensor('int64', tokenTypeIds, [1, validIds.length])

    const feeds = {
      input_ids: inputTensor,
      attention_mask: attentionTensor,
      token_type_ids: tokenTypeTensor
    }

    const results = await session.run(feeds)
    const lastHiddenState = results['last_hidden_state']
    const [, sequenceLength, hiddenSize] = lastHiddenState.dims
    const embeddingData = lastHiddenState.data

    // Apply mean pooling across the sequence dimension
    const pooledEmbedding = new Float32Array(hiddenSize)
    for (let i = 0; i < hiddenSize; i++) {
      let sum = 0
      for (let j = 0; j < sequenceLength; j++) {
        sum += embeddingData[j * hiddenSize + i]
      }
      pooledEmbedding[i] = sum / sequenceLength
    }

    embeddings.push(pooledEmbedding)
  }

  // If multiple chunks, average the embeddings
  if (embeddings.length === 1) {
    return embeddings[0]
  }

  const hiddenSize = embeddings[0].length
  const avgEmbedding = new Float32Array(hiddenSize)

  // Average across all chunks
  for (let i = 0; i < hiddenSize; i++) {
    let sum = 0
    for (const embedding of embeddings) {
      sum += embedding[i]
    }
    avgEmbedding[i] = sum / embeddings.length
  }

  return avgEmbedding
}

let session = null
let vocab = null

export function resetSession() {
  session = null
  vocab = null
}

export default async function calculateEmbeddings(text) {
  await downloadModelIfNeeded()

  if (!session || !vocab) {
    await initializeModelAndVocab()
  }

  const chunks = wordPieceTokenizer(text, vocab)

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
    const pooledEmbedding = await processChunkedEmbeddings(chunks, session)
    return normalizeEmbedding(pooledEmbedding)
  } catch (error) {
    // If inference fails, it might be due to model corruption
    // Try to recover by re-downloading and reinitializing
    // eslint-disable-next-line no-console
    console.warn('Model inference failed, attempting recovery...', error.message)

    await forceRedownloadModel()
    await initializeModelAndVocab()

    const retryPooledEmbedding = await processChunkedEmbeddings(chunks, session)
    return normalizeEmbedding(retryPooledEmbedding)
  }
}
