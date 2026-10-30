import { it, describe } from 'node:test'
import assert from 'node:assert'
import { packBlocks } from '../../../lib/markdownEmbeddings/chunker/stages/07-packBlocks.js'
import { parseBlocks } from '../../../lib/markdownEmbeddings/chunker/stages/04-parse-blocks.js'
import { transformBlock as transform } from '../../../lib/markdownEmbeddings/chunker/stages/05-transform.js'

// These tests exercise the packing algorithm with a deterministic char measure.
// The helper returns each chunk's embedded text (embeddingBody); tests that need
// the full-context displayBody call packBlocks directly.
const chunk = (blocks, budget, measure = (t) => t.length) =>
  packBlocks(blocks, { maxTokens: budget, measure }).map((c) => c.embeddingBody)

function makeBlocks(body) {
  const blocks = parseBlocks(body.trim())
  for (const block of blocks) {
    block.text = transform(block)
  }
  return blocks
}

const config = { budget: 200 }

describe('chunk', () => {
  describe('when packing blocks into chunks', () => {
    it('should not mutate the input blocks array', () => {
      const blocks = makeBlocks('First paragraph text here.\n\nSecond paragraph text.')
      const original = structuredClone(blocks)

      packBlocks(blocks, { maxTokens: 500, measure: (t) => t.length })

      assert.deepStrictEqual(blocks, original)
    })

    it('should pack blocks as tightly as possible — no two consecutive chunks fit within budget', () => {
      const blocks = Array.from({ length: 8 }, (_, i) => ({
        text: `Para ${i} adds some filler text.`,
        type: 'paragraph',
        supressCut: false
      }))
      const budget = 70
      const measure = (t) => t.length

      const packed = packBlocks(blocks, { maxTokens: budget, measure })

      assert.ok(packed.length > 1, 'expected multiple chunks')
      for (let i = 0; i < packed.length - 1; i++) {
        const merged = `${packed[i].embeddingBody}\n\n${packed[i + 1].embeddingBody}`
        assert.ok(
          measure(merged) > budget,
          `chunks ${i} and ${i + 1} fit together (${measure(merged)} ≤ ${budget}) — packing was not greedy`
        )
      }
    })

    it('should return a single chunk for a short body under the limit', () => {
      const body = 'A short paragraph well under the limit.'
      const chunks = chunk(makeBlocks(body), config.budget)

      assert.strictEqual(chunks.length, 1)
      assert.strictEqual(chunks[0], 'A short paragraph well under the limit.')
    })

    it('should return under-budget content without a splitting attempt', () => {
      const blocks = makeBlocks('First sentence. Second sentence.')
      let calls = 0
      const measure = (text) => {
        calls++
        return text.length
      }

      assert.deepStrictEqual(chunk(blocks, 200, measure), ['First sentence. Second sentence.'])
      assert.strictEqual(calls, 1)
    })

    it('should split two paragraphs that exceed the limit into two chunks', () => {
      const para = 'word '.repeat(30).trim()
      const body = `${para}\n\n${para}`
      const chunks = chunk(makeBlocks(body), config.budget)

      assert.strictEqual(chunks.length, 2)
      for (const chunk of chunks) {
        assert.ok(chunk.length > 0)
      }
    })

    it('should make split fragments share the same body and keep embedding text distinct', () => {
      const part = (text) => ({ text, type: 'paragraph', supressCut: false })
      const cases = [
        {
          name: 'paragraph',
          blocks: [
            part(
              'First paragraph sentence has enough detail. Second paragraph sentence has enough detail.'
            )
          ],
          maxTokens: 45
        },
        {
          name: 'markdown table',
          blocks: [
            {
              text: '| Name | Value |\n| - | - |\n| first | alpha |\n| second | beta |\n| third | gamma |',
              type: 'md-table',
              supressCut: false
            }
          ],
          maxTokens: 50
        },
        {
          name: 'html table',
          blocks: [
            {
              text: '| Name | Value |\n| first | alpha |\n| second | beta |\n| third | gamma |',
              type: 'html-table',
              supressCut: false
            }
          ],
          maxTokens: 45
        },
        {
          name: 'list',
          blocks: [
            {
              text: '1. First\n1. Second\n1. Third',
              type: 'list',
              supressCut: false,
              parts: [
                { text: '1. First', type: 'list-item', supressCut: false },
                { text: '1. Second', type: 'list-item', supressCut: false },
                { text: '1. Third', type: 'list-item', supressCut: false }
              ]
            }
          ],
          maxTokens: 12
        },
        {
          name: 'list item',
          blocks: [
            {
              text: '1. Step\nFirst child paragraph.\nSecond child paragraph.',
              opener: '1. Step',
              type: 'list-item',
              supressCut: false,
              parts: [part('First child paragraph.'), part('Second child paragraph.')]
            }
          ],
          maxTokens: 28
        },
        {
          name: 'container',
          blocks: [
            {
              text: '::: tip\nFirst child paragraph.\nSecond child paragraph.\n:::',
              opener: '::: tip',
              closer: ':::',
              type: 'container',
              supressCut: false,
              parts: [part('First child paragraph.'), part('Second child paragraph.')]
            }
          ],
          maxTokens: 35
        },
        {
          name: 'runtime wrapper',
          blocks: [
            {
              text: 'Java:\nFirst child paragraph.\nSecond child paragraph.',
              type: 'java-div',
              runtime: 'java',
              supressCut: false,
              parts: [part('First child paragraph.'), part('Second child paragraph.')]
            }
          ],
          maxTokens: 30
        },
        {
          name: 'admonition',
          blocks: [
            {
              text: '> [!tip] Note\n> First child paragraph.\n> Second child paragraph.',
              opener: '> [!tip] Note',
              type: 'admonition',
              supressCut: false,
              parts: [part('First child paragraph.'), part('Second child paragraph.')]
            }
          ],
          maxTokens: 45
        }
      ]

      for (const { name, blocks, maxTokens } of cases) {
        const packed = packBlocks(blocks, {
          maxTokens,
          measure: (text) => text.length
        })
        assert.ok(packed.length > 1, `${name} must split`)
        assert.ok(
          packed.every((fragment) => fragment.displayBody !== undefined),
          `${name} must expose displayBody`
        )
        assert.strictEqual(
          new Set(packed.map((f) => f.displayBody)).size,
          1,
          `${name} fragments must share one displayBody`
        )
        assert.ok(
          packed.every((f) => f.displayBody === blocks[0].text),
          `${name} displayBody must be the whole original block`
        )
        assert.ok(
          packed.some((f) => f.embeddingBody !== f.displayBody),
          `${name} must keep embedding text distinct from displayBody`
        )
        assert.ok(
          packed.every((f) => f.displayBody.length >= f.embeddingBody.length),
          `${name} displayBody must be at least as large as embedding text`
        )
      }
    })

    it('should return an empty array for an empty body', () => {
      assert.deepStrictEqual(chunk(makeBlocks(''), config.budget), [])
      assert.deepStrictEqual(chunk(makeBlocks('   \n\n  '), config.budget), [])
    })

    it('should return only trimmed chunks', () => {
      const para = 'word '.repeat(30).trim()
      const body = `\n\n  ${para}  \n\n${para}\n\n`
      const chunks = chunk(makeBlocks(body), config.budget)

      assert.ok(chunks.length > 0)
      for (const chunk of chunks) {
        assert.strictEqual(chunk, chunk.trim())
      }
    })

    it('should leave no chunk empty after trim', () => {
      const para = 'word '.repeat(30).trim()
      const body = `${para}\n\n${para}\n\n${para}`
      const chunks = chunk(makeBlocks(body), config.budget)
      assert.ok(chunks.length > 0)
      for (const chunk of chunks) {
        assert.ok(chunk.length > 0, 'empty chunk emitted')
        assert.strictEqual(chunk, chunk.trim(), 'chunk not trimmed')
      }
    })
  })

  describe('when packing individual blocks', () => {
    it('should not emit an under-budget unclosed ~~~ fence as-is', () => {
      const blocks = [{ text: '~~~sh\nnpm install', type: 'fence', supressCut: false }]

      const packed = packBlocks(blocks, {
        maxTokens: 1000,
        measure: (t) => t.length
      })

      assert.ok(packed.length > 0)
      for (const part of packed) {
        assert.strictEqual(
          (part.embeddingBody.match(/~{3,}/g) || []).length % 2,
          0,
          'tilde fences must stay balanced'
        )
      }
      assert.ok(packed.some((part) => part.embeddingBody.includes('npm install')))
    })

    it('should not treat an unclosed six-backtick fence as balanced', () => {
      const blocks = [{ text: '``````sh\nnpm install', type: 'fence', supressCut: false }]

      const packed = packBlocks(blocks, {
        maxTokens: 1000,
        measure: (t) => t.length
      })

      assert.ok(packed.length > 0)
      for (const part of packed) {
        assert.strictEqual(
          (part.embeddingBody.match(/`{3,}/g) || []).length % 2,
          0,
          'backtick fences must stay balanced'
        )
      }
      assert.ok(packed.some((part) => part.embeddingBody.includes('npm install')))
    })

    it('should split an oversized code-group into valid fenced chunks', () => {
      const codeLines = Array.from({ length: 20 }, (_, i) => `line ${i} of code`)
      const fence = (lang) => ['```' + lang, ...codeLines, '```'].join('\n')
      const body = ['::: code-group', fence('js'), fence('ts'), ':::'].join('\n')
      const blocks = makeBlocks(body)
      const original = blocks[0].text
      assert.strictEqual(blocks[0].type, 'container')
      assert.ok(original.length > config.budget)

      const packed = packBlocks(blocks, {
        maxTokens: config.budget,
        measure: (t) => t.length
      })

      assert.ok(packed.length > 1, 'oversized code-group must split')
      for (const part of packed) {
        assert.ok(
          part.embeddingBody.length <= config.budget,
          `fragment within budget: len=${part.embeddingBody.length}`
        )
        assert.strictEqual(
          (part.embeddingBody.match(/```/g) || []).length % 2,
          0,
          'fences stay balanced in each fragment'
        )
        assert.strictEqual(part.displayBody, original)
      }
    })

    describe('when the split lands on a fence between a lead-in and an anaphoric paragraph', () => {
      function createFixture() {
        const codeLines = Array.from({ length: 30 }, (_, i) => `const value${i} = compute(${i});`)
        const fenceText = ['```js', ...codeLines, '```'].join('\n')
        const leadIn = 'The following snippet shows the setup:'
        const anaphoric = 'These values feed the next step of the pipeline.'
        const blocks = [
          {
            text: 'Intro paragraph that sets the scene for the example below.',
            type: 'paragraph',
            supressCut: false
          },
          { text: leadIn, type: 'paragraph', isLeadIn: true, supressCut: false },
          { text: fenceText, type: 'fence', supressCut: true },
          { text: anaphoric, type: 'paragraph', isAnaphoric: true, supressCut: true },
          {
            text: 'A closing paragraph after the code block.',
            type: 'paragraph',
            supressCut: false
          }
        ]
        return { blocks, codeLines, fenceText, leadIn, anaphoric }
      }

      it('should wrap each fence fragment with lead-in prefix and anaphoric suffix within budget', () => {
        const { blocks } = createFixture()

        const packed = packBlocks(blocks, {
          maxTokens: config.budget,
          measure: (t) => t.length
        })

        const fenceChunks = packed.filter((p) => p.embeddingBody.includes('```js'))
        assert.ok(fenceChunks.length > 1, 'the fence must split into several fragments')
        for (const p of fenceChunks) {
          assert.match(
            p.embeddingBody,
            /^The following snippet shows the setup:\n\n```js[\s\S]*```\n\nThese values feed the next step of the pipeline\.$/,
            'each fragment is lead-in + fenced block + anaphoric suffix'
          )
          assert.ok(
            p.embeddingBody.length <= config.budget,
            `fence fragment within budget: len=${p.embeddingBody.length}`
          )
          assert.strictEqual(
            (p.embeddingBody.match(/```/g) || []).length % 2,
            0,
            'fences balanced in fragment'
          )
        }
      })

      it('should set displayBody to the whole fence with lead-in and anaphoric suffix in every fragment', () => {
        const { blocks, leadIn, fenceText, anaphoric } = createFixture()

        const packed = packBlocks(blocks, {
          maxTokens: config.budget,
          measure: (t) => t.length
        })

        const fenceChunks = packed.filter((p) => p.embeddingBody.includes('```js'))
        assert.ok(fenceChunks.length > 1)
        for (const p of fenceChunks)
          assert.strictEqual(p.displayBody, `${leadIn}\n\n${fenceText}\n\n${anaphoric}`)
      })

      it('should cover every code line across the fence fragments', () => {
        const { blocks, codeLines } = createFixture()

        const packed = packBlocks(blocks, {
          maxTokens: config.budget,
          measure: (t) => t.length
        })

        const fenceChunks = packed.filter((p) => p.embeddingBody.includes('```js'))
        assert.ok(fenceChunks.length > 1)
        for (let i = 0; i < codeLines.length; i++)
          assert.ok(
            fenceChunks.some((p) => p.embeddingBody.includes(`value${i} =`)),
            `code line value${i} must appear in some fence fragment`
          )
      })

      it('should emit the intro first, the closing paragraph last, and not emit the anaphoric block separately', () => {
        const { blocks, anaphoric } = createFixture()

        const bodies = chunk(blocks, config.budget)

        assert.match(bodies[0], /^Intro paragraph/)
        assert.strictEqual(bodies[bodies.length - 1], 'A closing paragraph after the code block.')
        const lastFenceIndex = bodies.map((b) => b.includes('```js')).lastIndexOf(true)
        assert.ok(lastFenceIndex >= 0, 'expected a fence fragment')
        assert.ok(lastFenceIndex < bodies.length - 1, 'the closing paragraph follows the fence')
        assert.ok(
          !bodies.includes(anaphoric),
          'anaphoric line must not be emitted as its own chunk'
        )
      })
    })

    it('should attach a trailing supressCut block as a suffix and not emit it twice', () => {
      const fence = [
        '```js',
        ...Array.from({ length: 20 }, (_, i) => `let x${i} = ${i};`),
        '```'
      ].join('\n')
      const table = '| A | B |\n| - | - |\n| 1 | 2 |'
      const blocks = [
        { text: fence, type: 'fence', supressCut: true },
        { text: table, type: 'md-table', supressCut: true }
      ]

      const chunks = chunk(blocks, config.budget)

      assert.ok(chunks.length > 1, 'the fence must split')
      for (const c of chunks) {
        assert.ok(c.endsWith(table), 'every fence fragment carries the table as a suffix')
        assert.ok(c.length <= config.budget, `fragment within budget: len=${c.length}`)
      }
      assert.ok(!chunks.includes(table), 'the table must not be emitted as its own chunk')
    })

    it('should drop the suffix when the lead-in, slice, and trailing block exceed budget', () => {
      const fence = [
        '```js',
        ...Array.from({ length: 20 }, (_, i) => `let value${i} = ${i};`),
        '```'
      ].join('\n')
      const bigTail = `| ${'H'.repeat(60)} |\n| ${'-'.repeat(60)} |\n| ${'v'.repeat(60)} |`
      const blocks = [
        {
          text: 'Run the following setup script:',
          type: 'paragraph',
          isLeadIn: true,
          supressCut: false
        },
        { text: fence, type: 'fence', supressCut: true },
        { text: bigTail, type: 'md-table', supressCut: true }
      ]

      const chunks = chunk(blocks, config.budget)

      const fenceChunks = chunks.filter((c) => c.includes('```js'))
      assert.ok(fenceChunks.length > 1, 'the fence must split')
      for (const c of fenceChunks) {
        assert.match(
          c,
          /^Run the following setup script:\n\n```js/,
          'lead-in still prefixes each fragment'
        )
        assert.ok(!c.includes('HHH'), 'the oversized trailing block is not attached as a suffix')
        assert.ok(c.length <= config.budget, `fragment within budget: len=${c.length}`)
      }
      assert.ok(chunks.includes(bigTail), 'the trailing block is emitted as its own chunk')
    })

    it('should split a code fence larger than the limit into valid fenced chunks', () => {
      const codeLines = Array.from({ length: 40 }, (_, i) => `line ${i} of code`)
      const body = ['```js', ...codeLines, '```'].join('\n')
      assert.ok(body.length > config.budget)

      const chunks = chunk(makeBlocks(body), config.budget)

      assert.ok(chunks.length > 1, 'oversized fence must split')
      for (const c of chunks) {
        assert.match(c, /^```js\n/)
        assert.match(c, /\n```$/)
        assert.ok(c.length <= config.budget, `fragment exceeds budget: ${c.length}`)
      }
      assert.deepStrictEqual(
        chunks.flatMap((c) => c.split('\n').slice(1, -1)),
        codeLines
      )
    })

    it('should not split a 4-backtick fence at an inner 3-backtick closer', () => {
      const body = [
        '````md',
        '```js',
        'inner code',
        '```',
        'more md content',
        '````',
        '',
        'after paragraph'
      ].join('\n')
      const chunks = chunk(makeBlocks(body), 2000)
      assert.ok(chunks[0].startsWith('````md'))
      assert.ok(chunks[0].includes('inner code'))
      assert.ok(chunks[0].includes('more md content'))
    })

    it('should split an oversized ~~~ fence into valid fenced chunks', () => {
      const codeLines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
      const body = ['~~~sh', ...codeLines, '~~~'].join('\n')
      assert.ok(body.length > config.budget)

      const chunks = chunk(makeBlocks(body), config.budget)

      assert.ok(chunks.length > 1, 'oversized ~~~ fence must split')
      for (const c of chunks) {
        assert.match(c, /^~~~sh\n/)
        assert.match(c, /\n~~~$/)
        assert.ok(c.length <= config.budget, `fragment exceeds budget: ${c.length}`)
      }
      assert.deepStrictEqual(
        chunks.flatMap((c) => c.split('\n').slice(1, -1)),
        codeLines
      )
    })

    it('should recognise a fence with an indented closer', () => {
      const body = ['```zsh', 'npm install', '  ```', '', 'paragraph after'].join('\n')
      const chunks = chunk(makeBlocks(body), 2000)
      assert.ok(chunks[0].includes('```zsh'), 'fence opener must be present')
      assert.ok(chunks[0].includes('npm install'), 'fence content must be present')
    })

    it('should split an oversized bullet list into multiple chunks each within budget', () => {
      const items = Array.from(
        { length: 17 },
        (_, i) => `- Item ${i}: Add/override annotations and extend the base app`
      )
      const body = items.join('\n')
      assert.ok(body.length > config.budget)
      const chunks = chunk(makeBlocks(body), config.budget)
      assert.ok(chunks.length > 1, 'oversized bullet list must be split')
      // every item must appear in some chunk
      for (let i = 0; i < items.length; i++) {
        assert.ok(
          chunks.some((c) => c.includes(`Item ${i}:`)),
          `Item ${i} must appear in some chunk`
        )
      }
      // every chunk must be within budget
      for (const c of chunks)
        assert.ok(c.length <= config.budget, `chunk exceeds budget: len=${c.length}`)
    })

    it('should split an oversized bullet list with blank lines between items correctly', () => {
      const body = [
        '- item one with some additional content to push length up',
        '',
        '- item two with some additional content to push length up',
        '',
        '- item three with some additional content to push length up',
        '',
        '- item four with some additional content to push length up'
      ].join('\n')
      assert.ok(body.length > config.budget)
      const chunks = chunk(makeBlocks(body), config.budget)
      assert.ok(chunks.length > 1, 'oversized bullet list with blank-line gaps must be split')
      for (const c of chunks)
        assert.ok(c.length <= config.budget, `chunk exceeds budget: len=${c.length}`)
      assert.ok(
        chunks.some((c) => c.includes('item one')),
        'item one must appear'
      )
      assert.ok(
        chunks.some((c) => c.includes('item four')),
        'item four must appear'
      )
    })

    it('should split an oversized numbered list at item boundaries', () => {
      const body = `This section summarizes best practices for implementing event handlers.

1. On which service should I register my event handler?

    Event handlers implementing business logic should be registered on an Application Service.
    When implementing technical requirements, you can register on the Persistence Service.

2. Which services should my event handlers usually interact with?

    The CAP Java SDK provides APIs that can be used in event handlers to interact with other services.
    These other services can be used to request data required by the event handler implementation.

3. How should I implement business logic shared across services?

    In general, design your services with specific use cases in mind. Nevertheless, it might be necessary
    to share certain business logic across multiple services using utility methods.`

      const chunks = chunk(makeBlocks(body), config.budget)

      // All three items must each appear in some chunk
      assert.ok(
        chunks.some((c) => c.includes('1.')),
        'item 1 must appear in some chunk'
      )
      assert.ok(
        chunks.some((c) => c.includes('2.')),
        'item 2 must appear in some chunk'
      )
      assert.ok(
        chunks.some((c) => c.includes('3.')),
        'item 3 must appear in some chunk'
      )
      // Items are split — they cannot all be in one chunk
      assert.ok(chunks.length > 1, 'oversized numbered list must be split')
      // All chunks must be within budget
      for (const c of chunks)
        assert.ok(c.length <= config.budget, `chunk exceeds budget: len=${c.length}`)
    })

    it('should repeat the preceding lead-in on oversized list continuations', () => {
      const intro = 'The following options are available:'
      const items = Array.from(
        { length: 8 },
        (_, i) => `- Option ${i} has enough detail to require another chunk`
      )
      const chunks = chunk(makeBlocks(`${intro}\n\n${items.join('\n')}`), 150)
      const listChunks = chunks.filter((c) => c.includes('Option'))

      assert.ok(listChunks.length > 1)
      for (const c of listChunks) assert.ok(c.includes(intro), `list chunk must carry intro: ${c}`)
      assert.strictEqual((listChunks[0].match(/The following options/g) || []).length, 1)
    })

    it('should split a four-item numbered list in a five-block flow when item 3 exceeds the budget', () => {
      const item = (number) => {
        const opener = `${number}. Item ${number}`
        const parts = ['alpha', 'beta'].map((word) => ({
          text: `Item ${number} ${word} has details.`,
          type: 'paragraph',
          supressCut: false
        }))
        return {
          text: `${opener}\n${parts.map((part) => part.text).join('\n')}`,
          opener,
          type: 'list-item',
          supressCut: false,
          parts
        }
      }
      const listItems = [1, 2, 3, 4].map(item)
      const blocks = [
        {
          text: 'Opening paragraph before procedure.',
          type: 'paragraph',
          supressCut: false
        },
        {
          text: 'The following numbered steps apply:',
          type: 'paragraph',
          isLeadIn: true,
          supressCut: false
        },
        {
          text: listItems.map((entry) => entry.text).join('\n'),
          type: 'list',
          supressCut: true,
          parts: listItems
        },
        {
          text: 'Following paragraph four.',
          type: 'paragraph',
          supressCut: false
        },
        {
          text: 'Following paragraph five.',
          type: 'paragraph',
          supressCut: false
        }
      ]
      const list = blocks[2]
      const measureWords = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0)

      assert.strictEqual(blocks.length, 5)
      assert.deepStrictEqual(
        blocks.map((block) => block.type),
        ['paragraph', 'paragraph', 'list', 'paragraph', 'paragraph']
      )
      assert.ok(blocks[1].isLeadIn)
      assert.strictEqual(list.type, 'list')
      assert.strictEqual(list.parts.length, 4)
      assert.ok(list.parts.every((item) => item.parts.length === 2))

      const packed = packBlocks(blocks, {
        maxTokens: 37,
        measure: measureWords
      })
      const listChunks = packed.filter((chunk) => /Item [13]/.test(chunk.embeddingBody))

      assert.strictEqual(listChunks.length, 2)
      assert.match(listChunks[0].embeddingBody, /1\. Item 1[\s\S]*2\. Item 2/)
      assert.doesNotMatch(listChunks[0].embeddingBody, /3\. Item 3/)
      assert.match(listChunks[1].embeddingBody, /3\. Item 3[\s\S]*4\. Item 4/)
      for (const chunk of listChunks) assert.ok(chunk.embeddingBody.includes(blocks[1].text))
      assert.ok(
        packed.some(
          (chunk) =>
            chunk.embeddingBody.includes('Following paragraph four.') &&
            chunk.embeddingBody.includes('Following paragraph five.')
        )
      )
    })

    it('should split an oversized paragraph only at sentence boundaries', () => {
      const sentences = [
        'The first sentence explains the initial behavior.',
        'The second sentence adds enough detail for another chunk.',
        'The third sentence completes the explanation.'
      ]
      const chunks = chunk(makeBlocks(sentences.join(' ')), 90)

      assert.ok(chunks.length > 1)
      for (const sentence of sentences)
        assert.strictEqual(chunks.filter((c) => c.includes(sentence)).length, 1)
      for (const c of chunks) assert.ok(c.length <= 90, `chunk exceeds budget: len=${c.length}`)
    })

    it('should make sentence fragments share the same body — the whole paragraph', () => {
      const body =
        'The first sentence explains the behavior. The second sentence requires another fragment.'
      const blocks = makeBlocks(body)
      const packed = packBlocks(blocks, {
        maxTokens: 55,
        measure: (text) => text.length
      })

      assert.ok(packed.length > 1)
      assert.strictEqual(new Set(packed.map((part) => part.displayBody)).size, 1)
      assert.ok(
        packed.every((part) => part.displayBody === blocks[0].text),
        'displayBody is the whole original paragraph'
      )
      assert.ok(
        packed.every((part) => part.displayBody.length >= part.embeddingBody.length),
        'displayBody is at least as large as embedding text'
      )
    })

    it('should trigger splitting only on overflow and keep subsequent fragments dedicated', () => {
      const blocks = makeBlocks(
        [
          'Short context.',
          '',
          'First sentence fills the remaining room. Second sentence becomes its own fragment. Third sentence also becomes its own fragment.',
          '',
          'Following block must not join the final fragment.'
        ].join('\n')
      )
      const packed = packBlocks(blocks, {
        maxTokens: 70,
        measure: (text) => text.length
      })

      assert.strictEqual(packed.length, 4)
      assert.ok(packed[0].embeddingBody.includes('Short context.'))
      assert.ok(packed[0].embeddingBody.includes('First sentence'))
      assert.strictEqual(packed[1].embeddingBody, 'Second sentence becomes its own fragment.')
      assert.strictEqual(packed[2].embeddingBody, 'Third sentence also becomes its own fragment.')
      assert.strictEqual(
        packed[3].embeddingBody,
        'Following block must not join the final fragment.'
      )
    })

    it('should keep consecutive headings with following content', () => {
      const blocks = [
        {
          text: 'Introductory prose that fills the first chunk.',
          type: 'paragraph',
          supressCut: false
        },
        {
          text: '###### First heading',
          type: 'heading',
          isLeadIn: true,
          supressCut: false
        },
        {
          text: '###### Second heading',
          type: 'heading',
          isLeadIn: true,
          supressCut: false
        },
        {
          text: '> [!tip] Note\n> Content following both headings.',
          type: 'admonition',
          supressCut: true
        }
      ]
      const chunks = packBlocks(blocks, {
        maxTokens: 70,
        measure: (text) => text.length
      }).map((c) => c.embeddingBody)

      assert.ok(chunks.every((chunk) => !/###### Second heading\s*$/.test(chunk)))
      assert.ok(
        chunks.some((chunk) => chunk.includes('###### First heading') && chunk.includes('> [!tip]'))
      )
    })

    it('should split a single oversized sentence at word boundaries', () => {
      const sentence = `${'word '.repeat(50).trim()}.`

      const fragments = chunk(makeBlocks(sentence), 80)

      assert.ok(fragments.length > 1, 'expected word-level split')
      for (const fragment of fragments)
        assert.ok(fragment.length <= 80, `fragment exceeds budget: ${fragment}`)
      assert.strictEqual(fragments.join(' '), sentence)
    })

    it('should repeat the runtime label on every split wrapper fragment', () => {
      const body = [
        '<div class="impl java">',
        '',
        'First sentence contains enough Java-specific detail to fill one fragment. Second sentence contains more Java-specific detail for the next fragment.',
        '',
        'Third sentence remains part of the same Java implementation wrapper.',
        '',
        '</div>'
      ].join('\n')
      const chunks = chunk(makeBlocks(body), 110)

      assert.ok(chunks.length > 1)
      for (const c of chunks) assert.ok(c.startsWith('Java:\n'), `missing runtime label: ${c}`)
    })

    it('should keep a numbered list with indented continuation after blank line atomic', () => {
      const body = [
        '1. First item short',
        '',
        '   Indented continuation of first item that adds more detail.',
        '',
        '2. Second item short',
        '',
        '   Indented continuation of second item that also adds detail.'
      ].join('\n')
      const chunks = chunk(makeBlocks(body), 2000)
      assert.strictEqual(
        chunks.length,
        1,
        'numbered list with indented continuations must be atomic'
      )
      assert.ok(chunks[0].includes('1.'))
      assert.ok(chunks[0].includes('2.'))
      assert.ok(chunks[0].includes('Indented continuation of second item'))
    })

    it('should split an oversized markdown pipe table by row and repeat the header in each chunk', () => {
      const rows = Array.from({ length: 20 }, (_, i) => `| Row ${i} | val | val | val | val |`)
      const table = [
        '| Feature | CQL | GraphQL | OData | SQL |',
        '| - | :-: | :-: | :-: | :-: |',
        ...rows
      ].join('\n')
      assert.ok(table.length > config.budget)
      const chunks = chunk(makeBlocks(table), config.budget)
      assert.ok(chunks.length > 1, 'oversized md table must be split')
      // Every chunk must start with the header row so the table stays readable
      for (const c of chunks)
        assert.ok(c.includes('Feature'), `each chunk must contain header: ${c.slice(0, 60)}`)
      // All data rows must appear somewhere
      assert.ok(
        chunks.some((c) => c.includes('Row 0')),
        'first row must appear'
      )
      assert.ok(
        chunks.some((c) => c.includes(`Row ${rows.length - 1}`)),
        'last row must appear'
      )
      // Every chunk within budget
      for (const c of chunks)
        assert.ok(c.length <= config.budget, `chunk exceeds budget: len=${c.length}`)
    })

    it('should split an oversized HTML table by row and preserve all rows', () => {
      const rows = Array.from(
        { length: 20 },
        (_, i) => `  <tr><td>col${i}</td><td>value${i}</td></tr>`
      )
      const table = [
        '<table>',
        '  <thead><tr><th>Col</th><th>Val</th></tr></thead>',
        ...rows,
        '</table>'
      ].join('\n')
      assert.ok(table.length > config.budget)
      const chunks = chunk(makeBlocks(table), config.budget)
      assert.ok(chunks.length > 1, 'oversized html table must be split')
      assert.ok(
        chunks.some((c) => c.includes('col0')),
        'first row must appear'
      )
      assert.ok(
        chunks.some((c) => c.includes('col19')),
        'last row must appear'
      )
      // Every chunk within budget
      for (const c of chunks)
        assert.ok(c.length <= config.budget, `chunk exceeds budget: len=${c.length}`)
    })

    it('should keep a GFM admonition blockquote with a nested fence atomic', () => {
      const body = [
        '> [!tip] How to enable reuse packages',
        '> The `@capire/common` package uses the `cds-plugin.js` technique.',
        '> ```json',
        '> { "cds": { "requires": { "common": "@capire/common" } } }',
        '> ```',
        '',
        'Paragraph after the admonition.'
      ].join('\n')
      const chunks = chunk(makeBlocks(body), config.budget)
      const admonChunk = chunks.find((c) => c.includes('[!tip]'))
      assert.ok(admonChunk, 'expected chunk with admonition')
      const fenceCount = (admonChunk.match(/```/g) || []).length
      assert.strictEqual(fenceCount % 2, 0, 'nested fence must be intact inside admonition')
    })

    it('should repeat the opener on each fragment of a split oversized GFM admonition', () => {
      const body = [
        '> [!warning] Important',
        '> First sentence contains enough detail for one fragment.',
        '> Second sentence contains enough detail for another fragment.',
        '> Third sentence contains enough detail for a final fragment.',
        '',
        'paragraph after'
      ].join('\n')
      const chunks = chunk(makeBlocks(body), 90)
      const admonChunks = chunks.filter((c) => c.includes('[!warning]'))
      assert.ok(admonChunks.length > 1, 'expected split admonition fragments')
      for (const admonition of admonChunks) {
        assert.match(admonition, /^> \[!warning\] Important/m)
        assert.ok(admonition.split('\n').every((line) => line.startsWith('> ')))
        assert.ok(admonition.length <= 90, `chunk exceeds budget: len=${admonition.length}`)
      }
    })

    it('should preserve a complete nested fence in a split GFM admonition', () => {
      const body = [
        '> [!tip] Configuration',
        '> First paragraph has enough detail to form a separate fragment.',
        '> ```json',
        '> { "option": "value" }',
        '> ```',
        '> Final paragraph has enough detail to form another fragment.'
      ].join('\n')
      const chunks = chunk(makeBlocks(body), 100)
      const fenceChunk = chunks.find((c) => c.includes('"option": "value"'))
      assert.ok(fenceChunk, 'expected fragment containing the nested fence')
      assert.match(fenceChunk, /^> \[!tip\] Configuration/m)
      assert.strictEqual((fenceChunk.match(/^> ```/gm) || []).length, 2)
    })

    it('should collect a <div class="cols-N"> block atomically', () => {
      const body = [
        'before paragraph',
        '',
        '<div class="cols-2">',
        '',
        '```js',
        'const a = 1;',
        '```',
        '',
        '</div>',
        '',
        'after paragraph'
      ].join('\n')
      const chunks = chunk(makeBlocks(body), 2000)
      assert.ok(chunks[0].includes('const a = 1;'), 'content inside cols div must be intact')
    })

    it('should track depth correctly for a nested div inside an impl-java div', () => {
      const body = [
        'before text',
        '',
        '<div class="impl java">',
        '',
        '<div class="inner">',
        'nested content',
        '</div>',
        '',
        '</div>',
        '',
        'after text'
      ].join('\n')
      const chunks = chunk(makeBlocks(body), 2000)
      const divChunk = chunks.find((c) => c.includes('Java:'))
      assert.ok(divChunk, 'expected chunk with impl div (transformed to Java:)')
      assert.ok(
        divChunk.includes('nested content'),
        'nested div content must be inside outer div chunk'
      )
    })
  })

  describe('when cut-point suppression is active', () => {
    it('should split a code fence and its anaphoric paragraph when together they exceed budget', () => {
      const codeLines = Array.from({ length: 10 }, (_, i) => `line ${i} of code`)
      const code = ['```js', ...codeLines, '```'].join('\n')
      const para = 'These are the results produced by the code above.'
      const body = `${code}\n\n${para}`
      assert.ok(code.length <= config.budget, 'fence alone fits within budget')
      assert.ok(para.length <= config.budget, 'paragraph alone fits within budget')
      assert.ok(body.length > config.budget, 'body must exceed budget')

      const chunks = chunk(makeBlocks(body), config.budget)

      assert.strictEqual(chunks.length, 2)
      assert.strictEqual(chunks[0], code)
      assert.strictEqual(chunks[1], para)
    })

    it('should suppress the cut-point when the next line is a fence opener', () => {
      const para = 'word '.repeat(20).trim()
      const code = ['```js', 'let x = 1;', '```'].join('\n')
      const body = `${para}\n\n${code}\n\nparagraph after`
      const chunks = chunk(makeBlocks(body), 120)
      const fenceChunk = chunks.find((c) => c.includes('```js'))
      assert.ok(fenceChunk, 'expected chunk containing fence opener')
      assert.ok(fenceChunk.includes('let x = 1;'), 'fence content must be in same chunk as opener')
    })

    it('should suppress the cut-point when the next line is a ::: container opener', () => {
      const para = 'word '.repeat(20).trim()
      const body = `${para}\n\n::: tip\nsome tip content here\n:::\n\nparagraph after`
      const chunks = chunk(makeBlocks(body), 120)
      const containerChunk = chunks.find((c) => c.includes('some tip content here'))
      assert.ok(containerChunk, 'expected chunk containing container content')
      assert.ok(
        containerChunk.includes('some tip content here'),
        'container content must be in same chunk as opener'
      )
    })

    it('should suppress the cut-point when the next paragraph starts with an anaphoric word', () => {
      const para = 'word '.repeat(10).trim()
      const anaphoricCases = [
        'These are the values returned by the method above.',
        'Those settings apply only when the service is in production mode.',
        'They are defined in the configuration file as shown.'
      ]
      for (const anaphoric of anaphoricCases) {
        const body = `${para}\n\n${anaphoric}`
        const chunks = chunk(makeBlocks(body), 200)
        assert.strictEqual(chunks.length, 1, `"${anaphoric.slice(0, 40)}" must stay with referent`)
      }
    })

    it('should suppress the cut-point when the prev line was a fence opener', () => {
      const para = 'word '.repeat(20).trim()
      const body = [`${para}`, '', '```js', '', 'let x = 1;', '```', '', 'after'].join('\n')
      const chunks = chunk(makeBlocks(body), 120)
      const fenceChunk = chunks.find((c) => c.includes('```js'))
      assert.ok(
        fenceChunk && fenceChunk.includes('let x = 1;'),
        'blank after fence opener must not split fence'
      )
    })

    it('should skip HTML stub lines when finding the next non-blank line for a cut-point check', () => {
      const para = 'word '.repeat(20).trim()
      const body = `${para}\n\n<UnderConstruction/>\n\n${para}`
      const chunks = chunk(makeBlocks(body), 120)
      assert.ok(chunks.length > 0)
      for (const c of chunks) assert.ok(c.trim().length > 0)
    })

    it('should suppress the cut-point when the prev line is a lead-in (colon, as shown, the following, etc.)', () => {
      const para = 'word '.repeat(10).trim()
      const cases = [
        'The following shows:',
        'The following configuration options are available:',
        'An example is shown below',
        'The setup is described as follows',
        'You can configure it like this',
        'The result is listed below',
        'As shown above',
        'In the following, we show you how to implement a `cds add` plugin for PostgreSQL support.'
      ]
      for (const leadIn of cases) {
        const body = `${para}\n\n${leadIn}\n\n${para}`
        const chunks = chunk(makeBlocks(body), 200)
        assert.strictEqual(
          chunks.length,
          1,
          `lead-in "${leadIn}" must not be separated from its content`
        )
      }
    })

    it('should suppress the cut when the paragraph starts with "Note that"', () => {
      const para = 'word '.repeat(10).trim()
      const body = `${para}\n\nNote that this applies only when the service is active.`
      const chunks = chunk(makeBlocks(body), 200)
      assert.strictEqual(chunks.length, 1, '"Note that" must suppress cut before it')
    })

    it('should suppress the cut when the paragraph starts with "Note:"', () => {
      const para = 'word '.repeat(10).trim()
      const body = `${para}\n\nNote: this is an important caveat about behavior.`
      const chunks = chunk(makeBlocks(body), 200)
      assert.strictEqual(chunks.length, 1, '"Note:" must suppress cut before it')
    })

    it('should suppress the cut when the paragraph starts with "In this"', () => {
      const para = 'word '.repeat(10).trim()
      const body = `${para}\n\nIn this section, we explain how to configure the service.`
      const chunks = chunk(makeBlocks(body), 200)
      assert.strictEqual(chunks.length, 1, '"In this" must suppress cut before it')
    })

    it('should respect the budget when "as shown below" appears mid-sentence', () => {
      const prev =
        'For upgrades to work, use open version ranges as shown below in your config, combined with package-lock.json for repeatable builds.'
      const next = 'Independent paragraph with no intro relationship to the above.'
      const body = `${prev}\n\n${next}`
      const blocks = makeBlocks(body)
      assert.ok(blocks[0].isLeadIn)

      const chunks = chunk(blocks, 140)

      assert.deepStrictEqual(chunks, [prev, next])
      assert.ok(chunks.every((c) => c.length <= 140))
    })

    it('should respect the budget when "the following" appears mid-sentence', () => {
      const prev =
        'We offer support for the following frameworks on all major platforms and operating systems.'
      const next = 'Independent paragraph with no intro relationship to the above sentence.'
      const body = `${prev}\n\n${next}`
      const blocks = makeBlocks(body)
      assert.ok(blocks[0].isLeadIn)

      const chunks = chunk(blocks, 140)

      assert.deepStrictEqual(chunks, [prev, next])
      assert.ok(chunks.every((c) => c.length <= 140))
    })

    it('should respect the budget when "like this" appears mid-sentence', () => {
      const prev =
        'We do not want to configure it like this in production; prefer the environment variable approach.'
      const next = 'Independent paragraph with no intro relationship to the above.'
      const body = `${prev}\n\n${next}`
      const blocks = makeBlocks(body)
      assert.ok(blocks[0].isLeadIn)

      const chunks = chunk(blocks, 140)

      assert.deepStrictEqual(chunks, [prev, next])
      assert.ok(chunks.every((c) => c.length <= 140))
    })

    it("should suppress the cut when the prev block's last non-stub line ends with a colon", () => {
      const para = 'word '.repeat(10).trim()
      const leadInBlock = `Here is the configuration:\n<SomeComponent/>`
      const body = `${para}\n\n${leadInBlock}\n\n${para}`
      const chunks = chunk(makeBlocks(body), 200)
      assert.strictEqual(chunks.length, 1, 'HTML stub after lead-in must not mask the lead-in')
    })
  })

  describe('when a lead-in or table context is present', () => {
    it('should keep a markdown pipe table with intro together (lead-in suppresses cut)', () => {
      const rows = Array.from({ length: 5 }, (_, i) => `| Row ${i} | val | val | val | val |`)
      const table = [
        '| Feature | CQL | GraphQL | OData | SQL |',
        '| - | :-: | :-: | :-: | :-: |',
        ...rows
      ].join('\n')
      const intro = 'The following table compares query language features:'
      const body = `${intro}\n\n${table}`
      const chunks = chunk(makeBlocks(body), 300)
      const tableChunk = chunks.find((c) => c.includes('Feature'))
      assert.ok(tableChunk, 'expected chunk with pipe table')
      assert.ok(tableChunk.includes(intro), 'intro must be in same chunk as table')
    })

    it('should carry the intro as a prefix in each chunk of a split HTML <table>', () => {
      const rows = Array.from(
        { length: 20 },
        (_, i) => `  <tr><td>col${i}</td><td>value${i}</td></tr>`
      )
      const table = [
        '<table>',
        '  <thead><tr><th>Col</th><th>Val</th></tr></thead>',
        ...rows,
        '</table>'
      ].join('\n')
      const intro = 'The following table lists all configuration properties:'
      const outro = 'Use these properties to configure your service.'
      const body = `${intro}\n\n${table}\n\n${outro}`

      const chunks = chunk(makeBlocks(body), config.budget)

      // The table is split — intro cannot be in the same chunk as all rows
      assert.ok(
        chunks.some((c) => c.includes('col0')),
        'first row must appear somewhere'
      )
      assert.ok(
        chunks.some((c) => c.includes('col19')),
        'last row must appear somewhere'
      )
      // Every table chunk carries the lead-in intro as a prefix
      const tableChunks = chunks.filter((c) => c.includes('col'))
      for (const c of tableChunks) {
        assert.ok(c.includes(intro), `table chunk must carry intro prefix: ${c.slice(0, 60)}`)
      }
    })
  })

  describe('when cutting across impl div blocks', () => {
    it('should not suppress the cut before a <div class="impl java/node"> block (supressCut=false)', () => {
      const para = 'word '.repeat(40).trim()
      const div = ['<div class="impl node">', '', 'node-specific content here', '', '</div>'].join(
        '\n'
      )
      const body = `${para}\n\n${div}`
      const chunks = chunk(makeBlocks(body), 200)
      const divChunk = chunks.find((c) => c.includes('Node.js:'))
      const paraChunk = chunks.find((c) => c.includes('word'))
      assert.ok(divChunk, 'expected chunk with impl node div (transformed to Node.js:)')
      assert.ok(paraChunk, 'expected chunk with para')
      assert.ok(
        divChunk !== paraChunk,
        'impl div must not suppress cut — para and div in separate chunks'
      )
    })

    it('should always start a new chunk for a <div class="impl java/node"> block', () => {
      const before = 'before '.repeat(30).trim()
      const after = 'after '.repeat(20).trim()
      const div = [
        '<div class="impl java">',
        '',
        '```sh',
        'mvn spring-boot:run',
        '```',
        '',
        '</div>'
      ].join('\n')
      const body = `${before}\n\n${div}\n\n${after}`
      const chunks = chunk(makeBlocks(body), 200)
      const divChunk = chunks.find((c) => c.includes('Java:'))
      assert.ok(divChunk, 'expected chunk with div (transformed to Java:)')
      assert.ok(divChunk.includes('mvn spring-boot:run'), 'fence inside div must be intact')
      assert.ok(!divChunk.includes(before), 'para before div must not be in div chunk')
    })
  })

  describe('when packing container variants', () => {
    it('should recognise :::code-group (no space) as a container opener', () => {
      const body = [
        ':::code-group',
        '```js [Node.js]',
        'const x = 1;',
        '```',
        ':::',
        '',
        'paragraph after'
      ].join('\n')
      const chunks = chunk(makeBlocks(body), 2000)
      assert.ok(chunks[0].includes('const x = 1;'), 'container content must be present')
    })

    it('should close a ::: container when the closer is ::::', () => {
      const body = ['::: tip some tip', 'tip content here', '::::', '', 'paragraph after'].join(
        '\n'
      )
      const chunks = chunk(makeBlocks(body), 2000)
      assert.ok(chunks[0].includes('tip content here'), 'container content must be present')
    })

    it('should close all nesting levels when inner ::: is reached (depth=0 rule)', () => {
      const codeLines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
      const body = [
        '::: details outer',
        '::: code-group',
        '```js',
        ...codeLines,
        '```',
        ':::',
        'paragraph after outer'
      ].join('\n')
      const chunks = chunk(makeBlocks(body), 2000)
      assert.ok(chunks[0].includes('line 0'), 'fence content must be present')
      assert.ok(
        chunks[0].includes('paragraph after outer'),
        'content after closer must be in same chunk'
      )
    })
  })

  describe('when carry-back is triggered', () => {
    it('should carry the prev block to a new chunk when a suppressed cut triggers carry-back', () => {
      const para1 = 'alpha '.repeat(18).trim()
      const para2 = 'beta '.repeat(18).trim()
      const para3 = 'These gamma word is an anaphoric continuation that adds more detail here.'
      const body = `${para1}\n\n${para2}\n\n${para3}`
      const chunks = chunk(makeBlocks(body), 200)
      assert.strictEqual(chunks.length, 2, 'carry-back must split into 2 chunks')
      assert.ok(chunks[0].includes('alpha'), 'chunk 0 must have para1')
      assert.ok(!chunks[0].includes('beta'), 'chunk 0 must not have para2')
      assert.ok(chunks[1].includes('beta'), 'chunk 1 must have para2')
      assert.ok(chunks[1].includes('These gamma'), 'chunk 1 must have anaphoric para3')
    })
  })

  describe('when measure injection is used', () => {
    const wordCount = (t) => t.split(/\s+/).filter(Boolean).length

    it('should split on word budget not character budget when a custom measure is used', () => {
      // 5 words each; word budget 8 — 5+0+5=10 > 8 so second block must not join first
      const para5 = 'alpha beta gamma delta epsilon'
      const body = `${para5}\n\n${para5}\n\n${para5}`
      const blocks = makeBlocks(body)
      const chunks = chunk(blocks, 8, wordCount)
      assert.ok(chunks.length > 1, 'must split when word budget is exceeded')
      for (const c of chunks) {
        assert.ok(wordCount(c) <= 8, `chunk exceeds word budget: "${c}"`)
      }
    })

    it('should produce the same result with the default chars measure as with an explicit chars measure', () => {
      const body = 'A short paragraph well under the limit.'
      const defaultResult = chunk(makeBlocks(body), 200)
      const explicitResult = chunk(makeBlocks(body), 200, (t) => t.length)
      assert.deepStrictEqual(defaultResult, explicitResult)
    })

    it('should compute sepCost from the measure — word measure gives sepCost=0 for \\n\\n', () => {
      // '\n\n' has 0 words; with wordCount measure, consecutive blocks add no sep tokens.
      // So budget of 5 fits two 3-word blocks (3+0+3=6 > 5 still splits) vs char budget.
      const p3 = 'one two three'
      const body = `${p3}\n\n${p3}`
      const wordChunks = chunk(makeBlocks(body), 5, wordCount)
      // 3 words + sepCost(0) + 3 words = 6 > 5 → should split
      assert.strictEqual(wordChunks.length, 2, 'word budget 5 must split two 3-word paragraphs')
    })
  })

  describe('when enforcing the rendered token budget', () => {
    it('should remeasure later fragments after a heading context is consumed', () => {
      const words = 'one two three four five six seven eight nine ten'
      const blocks = [
        { text: '# Heading', type: 'heading', supressCut: false },
        { text: words, type: 'paragraph', supressCut: false }
      ]
      const measure = (text) => text.length + (text.includes('# Heading') ? 12 : 0)

      const result = packBlocks(blocks, { maxTokens: 55, measure })

      assert.ok(result.length > 1)
      assert.ok(result.every((part) => measure(part.embeddingBody) <= 55))
      const embedded = result.map((part) => part.embeddingBody).join('\n')
      for (const word of words.split(' ')) {
        assert.strictEqual((embedded.match(new RegExp(`\\b${word}\\b`, 'g')) || []).length, 1, word)
      }
      assert.strictEqual((embedded.match(/# Heading/g) || []).length, 1)
    })

    it('should apply a non-additive heading/body penalty to every candidate', () => {
      const blocks = [
        { text: '# API', type: 'heading', supressCut: false },
        { text: 'alpha beta gamma delta epsilon', type: 'paragraph', supressCut: false },
        { text: 'zeta eta theta iota kappa', type: 'paragraph', supressCut: false }
      ]
      const measure = (text) =>
        text.length + (text.startsWith('# API') && text.length > 10 ? 30 : 0)

      const result = packBlocks(blocks, { maxTokens: 45, measure })

      assert.ok(result.length > 1)
      assert.ok(result.every((part) => measure(part.embeddingBody) <= 45))
      const embedded = result.map((part) => part.embeddingBody).join('\n')
      for (const word of 'alpha beta gamma delta epsilon zeta eta theta iota kappa'.split(' ')) {
        assert.strictEqual((embedded.match(new RegExp(`\\b${word}\\b`, 'g')) || []).length, 1, word)
      }
      assert.strictEqual((embedded.match(/# API/g) || []).length, 1)
    })

    it('should retry a suffix when boundary cost is non-additive', () => {
      const blocks = [
        { text: 'Lead-in:', type: 'paragraph', isLeadIn: true, supressCut: false },
        {
          text: ['```js', ...Array.from({ length: 12 }, (_, i) => `line ${i}`), '```'].join('\n'),
          type: 'fence',
          supressCut: true
        },
        { text: 'suffix paragraph with boundary cost', type: 'paragraph', supressCut: true }
      ]
      const measure = (text) =>
        text.length + (text.includes('Lead-in:') ? 9 : 0) + (text.includes('suffix') ? 17 : 0)
      // The fence must exceed the budget to exercise the structural split retry.
      const budget = 80
      assert.ok(measure(blocks[1].text) > budget)

      const result = packBlocks(blocks, { maxTokens: budget, measure })

      assert.ok(result.length > 1)
      assert.ok(result.every((part) => measure(part.embeddingBody) <= budget))
      const suffixParts = result.filter((part) => part.embeddingBody.includes('suffix paragraph'))
      assert.strictEqual(suffixParts.length, 1)
      const fenceParts = result.filter((part) => part.embeddingBody.includes('```'))
      assert.ok(fenceParts.length > 1)
      assert.ok(fenceParts.every((part) => !part.embeddingBody.includes('suffix paragraph')))
      assert.ok(result.some((part) => part.embeddingBody.includes('Lead-in:')))
      for (let index = 0; index < 12; index++) {
        assert.ok(
          result.some((part) => part.embeddingBody.split('\n').includes(`line ${index}`)),
          `line ${index}`
        )
      }
      for (const part of fenceParts)
        assert.strictEqual((part.embeddingBody.match(/```/g) || []).length % 2, 0)
    })

    it('should retain the complete display body when falling back to word splitting', () => {
      const original = `${'word '.repeat(60).trim()} 😀`
      const blocks = [{ text: original, type: 'paragraph', supressCut: false }]
      const normalized = (value) => value.replace(/\s+/gu, ' ').trim()

      const result = packBlocks(blocks, { maxTokens: 40, measure: (text) => text.length })

      assert.ok(result.length > 1)
      assert.ok(result.every((part) => part.embeddingBody.length <= 40))
      assert.ok(result.every((part) => part.displayBody === original))
      assert.strictEqual(
        normalized(result.map((part) => part.embeddingBody).join(' ')),
        normalized(original)
      )
    })

    it('should keep nested-fence fallback bounded and balanced without losing plain content', () => {
      const original = [
        '````md',
        '```js',
        'distinctive nested content',
        '```',
        'tail content',
        '````'
      ].join('\n')
      const blocks = [{ text: original, type: 'fence', supressCut: false }]
      const normalized = (value) => value.replace(/\s+/gu, ' ').trim()

      const result = packBlocks(blocks, { maxTokens: 24, measure: (text) => text.length })

      assert.ok(result.length > 1)
      assert.ok(result.every((part) => part.embeddingBody.length <= 24))
      for (const part of result)
        assert.strictEqual((part.embeddingBody.match(/```/g) || []).length % 2, 0)
      assert.strictEqual(
        normalized(result.map((part) => part.embeddingBody).join(' ')),
        'distinctive nested content tail content'
      )
      assert.ok(result.every((part) => part.displayBody === original))
    })

    it('should attach or split trailing headings without exceeding the budget', () => {
      const heading = `# ${'trailing heading '.repeat(3).trim()}`
      const body = 'body content that occupies the first chunk ' + 'x'.repeat(30)
      const blocks = [
        { text: body, type: 'paragraph', supressCut: false },
        { text: heading, type: 'heading', supressCut: false }
      ]

      const result = packBlocks(blocks, { maxTokens: 70, measure: (text) => text.length })

      assert.ok(result.length > 1)
      assert.ok(result.every((part) => part.embeddingBody.length <= 70))
      assert.ok(result.some((part) => part.embeddingBody.includes('trailing heading')))
    })

    it('should carry a lead-in once without losing content during absolute contextual fallback', () => {
      const leadIn = 'Important lead-in context:'
      const content = [
        '```js',
        'distinctive alpha',
        'distinctive beta',
        'distinctive gamma',
        '```'
      ].join('\n')
      const blocks = [
        { text: leadIn, type: 'paragraph', isLeadIn: true, supressCut: false },
        { text: content, type: 'fence', supressCut: false }
      ]
      const measure = (text) => text.length + (text.includes(leadIn) ? 15 : 0)

      const result = packBlocks(blocks, { maxTokens: 42, measure })

      const embedded = result.map((part) => part.embeddingBody).join(' ')
      assert.strictEqual((embedded.match(new RegExp(leadIn, 'g')) || []).length, 1)
      assert.ok(embedded.includes('distinctive alpha'))
      assert.ok(embedded.indexOf('distinctive alpha') < embedded.indexOf('distinctive beta'))
      assert.ok(embedded.indexOf('distinctive beta') < embedded.indexOf('distinctive gamma'))
      assert.ok(result.every((part) => measure(part.embeddingBody) <= 42))
      const display = result.map((part) => part.displayBody).join(' ')
      assert.ok(display.includes(leadIn))
      assert.ok(display.includes('distinctive gamma'))
    })
  })

  describe('given real-world block patterns', () => {
    it('should not treat a <span> before a fence opener as a meaningful prev line', () => {
      const body = `> Source: /docs/guides/integration/data-federation#motivation

There are many scenarios where data from remote services needs to be in close access locally. For example when we display lists of local data joined with remote data, as we introduce in the [*CAP-level Service Integration*](calesi.md#integration-logic-required) guide:

![XTravels Fiori list view showing a table of travel requests, with the Customer column empty.](assets/xtravels-list-.png)

![XTravels Fiori details view showing a travel requests, with the flights data missing](assets/xtravels-bookings-.png)

When we run that and look into the log output of the xtravels app server, we see some bulk requests as shown below, which indicates that the Fiori client is desparately trying to fetch the missing customer data. If we'd scroll the list in the UI this would repeat like crazy.

<span>

\`\`\`js
[odata] - POST /odata/v4/travel/$batch
[odata] - > GET /Travels(ID=4133,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4132,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4131,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4130,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4129,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4128,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4127,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4126,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4125,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4124,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4123,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4122,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4121,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4120,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4119,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4118,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4117,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4116,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4115,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4114,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4113,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4112,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4111,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4110,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4109,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4108,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4107,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4106,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4105,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
[odata] - > GET /Travels(ID=4104,IsActiveEntity=true) { '$select': 'Customer', '$expand': 'Customer($select=ID,Name)' }
\`\`\`
</span>

Relying on live calls to remote services per row is clearly not an option. Instead, we'd rather ensure that data required in close access is really available locally, so it can be joined with own data using SQL JOINs. This is what _data federation_ is all about.`

      const chunks = chunk(makeBlocks(body), 512 * 3)

      for (const chunk of chunks) {
        const count = (chunk.match(/```/g) || []).length
        assert.strictEqual(count % 2, 0, `unclosed fence in chunk: ${chunk.slice(0, 80)}`)
      }
      const fenceChunks = chunks.filter((c) => c.includes('```js'))
      assert.ok(chunks.length > 3, 'prose before, several fence fragments, prose after')
      assert.ok(fenceChunks.length > 1, 'oversized fence must split')
      assert.ok(chunks.every((c) => c.length <= 512 * 3))
      assert.ok(
        fenceChunks.every((c) => c.includes('[odata]')),
        'every fence fragment must carry code with its opener'
      )
      assert.deepStrictEqual(
        fenceChunks.join('\n').match(/^\[odata\].*$/gm),
        body.match(/^\[odata\].*$/gm)
      )
    })
  })

  describe('when filling flowchart gaps', () => {
    it('should return an empty array for chunk([])', () => {
      assert.deepStrictEqual(chunk([], 100), [])
    })

    it('should hard-split a single block larger than the budget without losing content', () => {
      const big = {
        text: 'x'.repeat(500),
        type: 'paragraph',
        supressCut: false
      }

      const chunks = chunk([big], 100)

      assert.ok(chunks.length > 1)
      assert.ok(chunks.every((c) => c.length <= 100))
      assert.strictEqual(chunks.join(''), big.text)
    })

    it('should keep both blocks within budget when cut is suppressed and current has size 1', () => {
      const first = {
        text: 'a'.repeat(90),
        type: 'paragraph',
        supressCut: false
      }
      const second = {
        text: '```\ncode block bigger than remaining space\n```',
        type: 'fence',
        supressCut: true
      }

      const chunks = chunk([first, second], 100)

      assert.strictEqual(chunks.length, 2)
      assert.strictEqual(chunks[0], first.text)
      assert.strictEqual(chunks[1], second.text)
      assert.ok(chunks.every((c) => c.length <= 100))
    })

    it('should not duplicate the carried block across chunks during carry-back', () => {
      const A = {
        text: 'A'.repeat(80),
        type: 'paragraph',
        supressCut: false,
        isLeadIn: false,
        isAnaphoric: false
      }
      const B = {
        text: 'B'.repeat(30),
        type: 'paragraph',
        supressCut: false,
        isLeadIn: false,
        isAnaphoric: false
      }
      const C = { text: '```\nCcc\n```', type: 'fence', supressCut: true }
      const chunks = chunk([A, B, C], 100)
      assert.strictEqual(chunks.length, 2)
      assert.ok(
        chunks[0].includes('A'.repeat(80)) && !chunks[0].includes('B'.repeat(30)),
        `chunk 0 should have only A; got: ${chunks[0]}`
      )
      assert.ok(
        chunks[1].includes('B'.repeat(30)) && chunks[1].includes('Ccc'),
        `chunk 1 should have B and C; got: ${chunks[1]}`
      )
      const bCount = (chunks.join('|').match(/B{30}/g) || []).length
      assert.strictEqual(bCount, 1, 'B must appear in exactly one chunk')
    })

    it('should produce no chunks for a block containing only whitespace', () => {
      const b = { text: '   \n\n   ', type: 'paragraph', supressCut: false }
      const chunks = chunk([b], 100)
      assert.deepStrictEqual(chunks, [])
    })

    it('should respect the budget when supressCut, isAnaphoric, and prev.isLeadIn are all true', () => {
      const prev = {
        text: 'p'.repeat(90),
        type: 'paragraph',
        supressCut: false,
        isLeadIn: true,
        isAnaphoric: false
      }
      const next = {
        text: '```\nnext\n```',
        type: 'fence',
        supressCut: true,
        isAnaphoric: true
      }

      const chunks = chunk([prev, next], 100)

      assert.strictEqual(chunks.length, 2)
      assert.strictEqual(chunks[0], prev.text)
      assert.strictEqual(chunks[1], next.text)
      assert.ok(chunks.every((c) => c.length <= 100))
    })
  })
})
