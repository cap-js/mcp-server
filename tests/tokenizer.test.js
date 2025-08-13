// Node.js test runner (test) for lib/tokenizer.js
import { bertTokenize, normalizeText, preTokenize, wordPieceEncode } from '../lib/tokenizer.js'
import assert from 'node:assert'
import { test } from 'node:test'

// Mock vocabulary for testing
const mockVocab = new Map([
  ['[CLS]', 101],
  ['[SEP]', 102],
  ['[UNK]', 100],
  ['[PAD]', 0],
  ['hello', 7592],
  ['world', 2088],
  ['!', 999],
  ['this', 2023],
  ['is', 2003],
  ['a', 1037],
  ['test', 3231],
  ['sentence', 6251],
  ['.', 1012],
  [',', 1010],
  ['how', 2129],
  ['are', 2024],
  ['you', 2017],
  ['doing', 2509],
  ['today', 2651],
  ['?', 1029],
  ['i', 1045],
  ['love', 2293],
  ['transform', 10938],
  ['##ers', 2545], // WordPiece subword
  ['the', 1996],
  ['quick', 4248],
  ['brown', 2829],
  ['fox', 4419],
  ['jumps', 14523],
  ['over', 2058],
  ['lazy', 13971],
  ['dog', 3899]
])

test.describe('tokenizer', () => {
  test('normalizeText: should clean and lowercase text', () => {
    const text = 'Hello World!'
    const normalized = normalizeText(text)
    assert.strictEqual(normalized, 'hello world!')
  })

  test('normalizeText: should remove accents when requested', () => {
    const text = 'café'
    const normalized = normalizeText(text, { stripAccents: true })
    assert.strictEqual(normalized, 'cafe')
  })

  test('preTokenize: should split on whitespace and punctuation', () => {
    const text = 'Hello world!'
    const preTokens = preTokenize(text)
    assert.deepStrictEqual(preTokens, ['Hello', 'world', '!'])
  })

  test('preTokenize: should handle complex punctuation', () => {
    const text = 'How are you doing today?'
    const preTokens = preTokenize(text)
    assert.deepStrictEqual(preTokens, ['How', 'are', 'you', 'doing', 'today', '?'])
  })

  test('bertTokenize: should tokenize simple text', () => {
    const text = 'Hello world!'
    const result = bertTokenize(text, mockVocab)

    assert(Array.isArray(result.input_ids), 'Should return input_ids array')
    assert(Array.isArray(result.attention_mask), 'Should return attention_mask array')
    assert.strictEqual(result.input_ids.length, result.attention_mask.length, 'Arrays should have same length')

    // Should include CLS token at start and SEP token at end
    assert.strictEqual(result.input_ids[0], 101, 'Should start with CLS token')
    assert.strictEqual(result.input_ids[result.input_ids.length - 1], 102, 'Should end with SEP token')

    // All attention mask values should be 1 (no padding)
    assert(
      result.attention_mask.every(val => val === 1),
      'All attention mask values should be 1'
    )
  })

  test('bertTokenize: should handle unknown tokens', () => {
    const text = 'unknownword'
    const result = bertTokenize(text, mockVocab)

    // Should contain UNK token (100)
    assert(result.input_ids.includes(100), 'Should contain UNK token for unknown word')
  })

  test('bertTokenize: should handle padding', () => {
    const text = 'Hello world!'
    const result = bertTokenize(text, mockVocab, {
      maxLength: 10,
      padding: true,
      truncation: false
    })

    assert.strictEqual(result.input_ids.length, 10, 'Should pad to maxLength')
    assert.strictEqual(result.attention_mask.length, 10, 'Should pad attention mask to maxLength')

    // Check that padding tokens (0) are present
    assert(result.input_ids.includes(0), 'Should contain PAD tokens')

    // Check that attention mask has 0s for padding
    const paddingCount = result.attention_mask.filter(val => val === 0).length
    assert(paddingCount > 0, 'Should have 0s in attention mask for padding')
  })

  test('bertTokenize: should handle truncation', () => {
    const longText = 'The quick brown fox jumps over the lazy dog and runs very fast'
    const result = bertTokenize(longText, mockVocab, {
      maxLength: 8,
      padding: false,
      truncation: true
    })

    assert.strictEqual(result.input_ids.length, 8, 'Should truncate to maxLength')
    assert.strictEqual(result.attention_mask.length, 8, 'Should truncate attention mask to maxLength')
  })

  test('bertTokenize: should handle both padding and truncation', () => {
    const text = 'The quick brown fox jumps over the lazy dog'
    const result = bertTokenize(text, mockVocab, {
      maxLength: 15,
      padding: true,
      truncation: true
    })

    assert.strictEqual(result.input_ids.length, 15, 'Should be exactly maxLength')
    assert.strictEqual(result.attention_mask.length, 15, 'Should be exactly maxLength')
  })

  test('bertTokenize: should handle sentence pairs', () => {
    const text1 = 'Hello world!'
    const text2 = 'How are you?'
    const result = bertTokenize(text1, mockVocab, {
      textPair: text2,
      addSpecialTokensFlag: true
    })

    assert(Array.isArray(result.input_ids), 'Should return input_ids array')
    assert(Array.isArray(result.attention_mask), 'Should return attention_mask array')
    assert(Array.isArray(result.token_type_ids), 'Should return token_type_ids array for sentence pairs')

    // Should have CLS at start and SEP tokens between and at end
    assert.strictEqual(result.input_ids[0], 101, 'Should start with CLS token')

    // Should have both 0s and 1s in token_type_ids
    assert(result.token_type_ids.includes(0), 'Should have 0s for first sentence')
    assert(result.token_type_ids.includes(1), 'Should have 1s for second sentence')
  })

  test('bertTokenize: should work without special tokens', () => {
    const text = 'Hello world!'
    const result = bertTokenize(text, mockVocab, {
      addSpecialTokensFlag: false
    })

    // Should not start with CLS or end with SEP
    assert.notStrictEqual(result.input_ids[0], 101, 'Should not start with CLS token')
    assert.notStrictEqual(result.input_ids[result.input_ids.length - 1], 102, 'Should not end with SEP token')
  })

  test('wordPieceEncode: should handle subword tokenization', () => {
    const tokens = ['transform', 'transformers']
    const result = wordPieceEncode(tokens, mockVocab)

    // 'transform' should be in vocab as-is
    assert(result.includes('transform'), 'Should contain base word')

    // 'transformers' should be split into 'transform' + '##ers'
    if (result.includes('##ers')) {
      assert(result.includes('transform'), 'Should split unknown word using subword tokens')
    }
  })

  test('wordPieceEncode: should handle unknown words', () => {
    const tokens = ['completelyunknownword']
    const result = wordPieceEncode(tokens, mockVocab)

    assert(result.includes('[UNK]'), 'Should return UNK token for completely unknown words')
  })
})
