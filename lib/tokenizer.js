/**
 * Custom BERT-style tokenizer implementation
 * Extracted from transformers.js WordPiece tokenization logic
 */

/**
 * Remove accents from text using Unicode normalization
 */
function removeAccents(text) {
  return text.normalize('NFD').replace(/\p{Mn}/gu, '')
}

/**
 * Check if character is a control character
 */
function isControl(char) {
  switch (char) {
    case '\t':
    case '\n':
    case '\r':
      return false
    default:
      return /^\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}$/u.test(char)
  }
}

/**
 * Clean and normalize text (BERT normalization)
 */
function normalizeText(text, options = {}) {
  const { cleanText = true, lowercase = true, stripAccents = true } = options

  if (cleanText) {
    // Remove control characters and normalize whitespace
    const output = []
    for (const char of text) {
      const cp = char.charCodeAt(0)
      if (cp === 0 || cp === 0xfffd || isControl(char)) {
        continue
      }
      if (/^\s$/.test(char)) {
        output.push(' ')
      } else {
        output.push(char)
      }
    }
    text = output.join('')
  }

  if (lowercase) {
    text = text.toLowerCase()
    if (stripAccents) {
      text = removeAccents(text)
    }
  } else if (stripAccents) {
    text = removeAccents(text)
  }

  return text
}

/**
 * BERT pre-tokenization - split on whitespace and punctuation
 */
function preTokenize(text) {
  const punctuationRegex = '\\p{P}\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E'
  const pattern = new RegExp(`[^\\s${punctuationRegex}]+|[${punctuationRegex}]`, 'gu')
  return text.trim().match(pattern) || []
}

/**
 * WordPiece encoding implementation
 */
function wordPieceEncode(
  tokens,
  vocab,
  unkToken = '[UNK]',
  continuingSubwordPrefix = '##',
  maxInputCharsPerWord = 100
) {
  const outputTokens = []

  for (const token of tokens) {
    const chars = [...token]
    if (chars.length > maxInputCharsPerWord) {
      outputTokens.push(unkToken)
      continue
    }

    let isUnknown = false
    let start = 0
    const subTokens = []

    while (start < chars.length) {
      let end = chars.length
      let currentSubstring = null

      while (start < end) {
        let substr = chars.slice(start, end).join('')

        if (start > 0) {
          substr = continuingSubwordPrefix + substr
        }

        if (vocab.has(substr)) {
          currentSubstring = substr
          break
        }

        end--
      }

      if (currentSubstring === null) {
        isUnknown = true
        break
      }

      subTokens.push(currentSubstring)
      start = end
    }

    if (isUnknown) {
      outputTokens.push(unkToken)
    } else {
      outputTokens.push(...subTokens)
    }
  }

  return outputTokens
}

/**
 * Post-processing - add special tokens
 */
function addSpecialTokens(tokens, tokensPair = null, clsToken = '[CLS]', sepToken = '[SEP]') {
  let result = [clsToken, ...tokens, sepToken]
  let tokenTypeIds = new Array(result.length).fill(0)

  if (tokensPair !== null) {
    result = [...result, ...tokensPair, sepToken]
    tokenTypeIds = [...tokenTypeIds, ...new Array(tokensPair.length + 1).fill(1)]
  }

  return { tokens: result, tokenTypeIds }
}

/**
 * Convert tokens to IDs using vocabulary
 */
function convertTokensToIds(tokens, vocab, unkTokenId) {
  return tokens.map(token => vocab.get(token) ?? unkTokenId)
}

/**
 * Main BERT tokenizer function
 * @param {string} text - Input text to tokenize
 * @param {Map<string, number>} vocab - Vocabulary mapping tokens to IDs
 * @param {Object} options - Tokenization options
 * @returns {Object} Tokenization result with input_ids, attention_mask, token_type_ids
 */
function bertTokenize(text, vocab, options = {}) {
  const {
    textPair = null,
    addSpecialTokensFlag = true,
    maxLength = 512,
    padding = false,
    truncation = false,
    unkToken = '[UNK]',
    clsToken = '[CLS]',
    sepToken = '[SEP]',
    padToken = '[PAD]',
    continuingSubwordPrefix = '##',
    normalizationOptions = {}
  } = options

  // Get token IDs
  const unkTokenId = vocab.get(unkToken) ?? 100 // Default BERT UNK ID
  const padTokenId = vocab.get(padToken) ?? 0 // Default BERT PAD ID

  // Step 1: Normalize text
  const normalizedText = normalizeText(text, normalizationOptions)
  const normalizedTextPair = textPair ? normalizeText(textPair, normalizationOptions) : null

  // Step 2: Pre-tokenize
  const preTokens = preTokenize(normalizedText)
  const preTokensPair = normalizedTextPair ? preTokenize(normalizedTextPair) : null

  // Step 3: WordPiece encode
  const tokens = wordPieceEncode(preTokens, vocab, unkToken, continuingSubwordPrefix)
  const tokensPair = preTokensPair ? wordPieceEncode(preTokensPair, vocab, unkToken, continuingSubwordPrefix) : null

  // Step 4: Add special tokens
  let finalTokens = tokens
  let tokenTypeIds = null

  if (addSpecialTokensFlag) {
    const result = addSpecialTokens(tokens, tokensPair, clsToken, sepToken)
    finalTokens = result.tokens
    tokenTypeIds = result.tokenTypeIds
  } else if (tokensPair) {
    finalTokens = [...tokens, ...tokensPair]
    tokenTypeIds = [...new Array(tokens.length).fill(0), ...new Array(tokensPair.length).fill(1)]
  }

  // Step 5: Convert to IDs
  let inputIds = convertTokensToIds(finalTokens, vocab, unkTokenId)

  // Step 6: Handle truncation
  if (truncation && inputIds.length > maxLength) {
    inputIds = inputIds.slice(0, maxLength)
    if (tokenTypeIds) tokenTypeIds = tokenTypeIds.slice(0, maxLength)
  }

  // Step 7: Handle padding
  let attentionMask = new Array(inputIds.length).fill(1)
  if (padding && inputIds.length < maxLength) {
    const padLength = maxLength - inputIds.length
    inputIds = [...inputIds, ...new Array(padLength).fill(padTokenId)]
    attentionMask = [...attentionMask, ...new Array(padLength).fill(0)]
    if (tokenTypeIds) tokenTypeIds = [...tokenTypeIds, ...new Array(padLength).fill(0)]
  }

  const result = {
    input_ids: inputIds,
    attention_mask: attentionMask
  }

  if (tokenTypeIds) {
    result.token_type_ids = tokenTypeIds
  }

  return result
}

export {
  bertTokenize,
  normalizeText,
  preTokenize,
  wordPieceEncode,
  addSpecialTokens,
  convertTokensToIds,
  removeAccents,
  isControl
}
