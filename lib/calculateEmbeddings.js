import fs from 'fs/promises'
import { constants } from 'fs'
import { createHash, randomUUID } from 'crypto'
import path from 'path'
import * as ort from 'onnxruntime-web'
import { MODEL_DIR } from './cache.js'

ort.env.debug = false
ort.env.logLevel = 'error'

const offline = process.argv.includes('--offline') || process.env.CDS_MCP_OFFLINE === 'true'

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2'
// Update the immutable revision and all digests together after reviewing a new upstream model release.
export const MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9'

export const MODEL_ARTIFACTS = [
  {
    file: 'onnx/model.onnx',
    sha256: '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e'
  },
  {
    file: 'tokenizer.json',
    sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0'
  },
  {
    file: 'tokenizer_config.json',
    sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3'
  }
].map(artifact => ({
  ...artifact,
  name: path.basename(artifact.file),
  url: `https://huggingface.co/${MODEL_NAME}/resolve/${MODEL_REVISION}/${artifact.file}`
}))

async function fileExists(filePath) {
  try {
    await fs.access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function verifyBuffer(buffer, expectedSha256, name) {
  const actualSha256 = digest(buffer)
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Integrity check failed for ${name}`)
  }
}

export async function readVerifiedFile(filePath, expectedSha256) {
  const buffer = await fs.readFile(filePath)
  verifyBuffer(buffer, expectedSha256, path.basename(filePath))
  return buffer
}

export async function verifyFile(filePath, expectedSha256) {
  await readVerifiedFile(filePath, expectedSha256)
}

export async function downloadFile(url, outputPath, expectedSha256, fetchImpl = fetch) {
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`Failed to download ${url}, status ${res.status}`)

  const buffer = Buffer.from(await res.arrayBuffer())
  verifyBuffer(buffer, expectedSha256, path.basename(outputPath))

  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, buffer, { flag: 'wx' })
    await fs.rename(temporaryPath, outputPath)
  } finally {
    await fs.unlink(temporaryPath).catch(() => {})
  }
}

export async function ensureModelArtifacts({
  directory = MODEL_DIR,
  artifacts = MODEL_ARTIFACTS,
  offlineMode = offline,
  force = false,
  fetchImpl = fetch
} = {}) {
  await fs.mkdir(directory, { recursive: true })
  let updated = false

  for (const artifact of artifacts) {
    const filePath = path.join(directory, artifact.name)
    if (!force && (await fileExists(filePath))) {
      try {
        await verifyFile(filePath, artifact.sha256)
        continue
      } catch (error) {
        if (offlineMode) throw error
      }
    }

    if (offlineMode) throw new Error(`Missing model artifact in offline mode: ${artifact.name}`)
    await downloadFile(artifact.url, filePath, artifact.sha256, fetchImpl)
    updated = true
  }

  return { updated }
}

export async function forceDownloadModel() {
  if (offline) throw new Error('Offline mode prevents model downloads')
  await ensureModelArtifacts({ force: true })
}

async function forceRedownloadModel() {
  if (offline) throw new Error('Model corrupted and --offline prevents re-download')

  session = null
  vocab = null
  await ensureModelArtifacts({ force: true })
}

async function initializeModelAndVocab() {
  await ensureModelArtifacts()

  const modelPath = path.join(MODEL_DIR, 'model.onnx')
  const vocabPath = path.join(MODEL_DIR, 'tokenizer.json')
  const modelArtifact = MODEL_ARTIFACTS.find(artifact => artifact.name === 'model.onnx')
  const tokenizerArtifact = MODEL_ARTIFACTS.find(artifact => artifact.name === 'tokenizer.json')

  const loadModelAndVocab = async () => {
    // Verify the exact buffers passed to the parsers to avoid a check/use race on the cache paths.
    const [modelBuffer, tokenizerBuffer] = await Promise.all([
      readVerifiedFile(modelPath, modelArtifact.sha256),
      readVerifiedFile(vocabPath, tokenizerArtifact.sha256)
    ])
    session = await ort.InferenceSession.create(modelBuffer)

    // Try to parse tokenizer JSON
    const tokenizerJson = JSON.parse(tokenizerBuffer.toString('utf8'))

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
    if (offline) throw error
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
        throw new Error(`Invalid token ID detected: ${id} (type: ${typeof id})`)
      }
      return isValid
    })

    if (validIds.length !== ids.length) {
      throw new Error(`Found ${ids.length - validIds.length} invalid token IDs`)
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

// Start downloading and initializing model when module loads
const modelInitPromise = (async () => {
  try {
    await initializeModelAndVocab()
  } catch {
    // Don't throw here - let the main function handle initialization
  }
})()

export function resetSession() {
  session = null
  vocab = null
}

export default async function calculateEmbeddings(text) {
  // Wait for the model to be preloaded, then ensure it's initialized
  await modelInitPromise

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
    if (offline) throw error
    // If inference fails, it might be due to model corruption
    // Try to recover by re-downloading and reinitializing

    await forceRedownloadModel()
    await initializeModelAndVocab()

    const retryPooledEmbedding = await processChunkedEmbeddings(chunks, session)
    return normalizeEmbedding(retryPooledEmbedding)
  }
}
