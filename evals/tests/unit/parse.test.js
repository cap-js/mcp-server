import { it, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from '../../lib/retrieval/createSourceDb/pipeline/stages/01-parse.js'
import { parseBlocks } from '../../lib/retrieval/createSourceDb/pipeline/stages/04-parse-blocks.js'

describe('parse — container nesting', () => {
  it('should keep a heading inside an outer container that follows a nested closed container', () => {
    const text = [
      '# Doc Title',
      'Source: /docs/x',
      '::: tip',
      '::: note',
      'inner text',
      ':::',
      '## Inside',
      'Source: /docs/x#inside',
      ':::'
    ].join('\n')

    const roots = parse(text)

    // The `## Inside` heading sits inside `::: tip`; the nested `::: note … :::`
    // must not be mistaken for the outer closer, so it stays body — not a node.
    assert.equal(roots.length, 1)
    assert.equal(roots[0].title, 'Doc Title')
    assert.equal(roots[0].children.length, 0)
  })
})

describe('parseBlocks — fenced code closer', () => {
  it('should not treat an info-string line as the closing fence', () => {
    const text = ['```', 'code A', '```js', 'code B', '```'].join('\n')

    const blocks = parseBlocks(text, [])

    const fences = blocks.filter((b) => b.type === 'fence')
    assert.equal(fences.length, 1)
    assert.ok(fences[0].text.includes('code B'))
  })
})
