import { it, describe } from 'node:test'
import assert from 'node:assert'
import { splitByRuntime } from '../../../lib/markdownEmbeddings/chunker/stages/06-splitByRuntime.js'

// Minimal block constructors — splitByRuntime only inspects runtime and parts.
const para = (text, runtime) => ({
  type: 'paragraph',
  text,
  ...(runtime ? { runtime } : {})
})
const mixedBlock = (jText, nText) => ({
  type: 'paragraph',
  text: `${jText}\n\n${nText}`,
  parts: [
    { type: 'paragraph', text: jText, runtime: 'java' },
    { type: 'paragraph', text: nText, runtime: 'node' }
  ]
})

describe('splitByRuntime', () => {
  describe('when the heading has a runtime label', () => {
    it('should place a pure-opposite block in its own labelled group and the rest in the primary group', () => {
      const javaBlock = para('Java content.', 'java')
      const nodeBlock = para('Node.js content.', 'node')
      const sharedBlock = para('Shared content.')
      const groups = splitByRuntime([javaBlock, nodeBlock, sharedBlock], 'Java Events')

      assert.strictEqual(groups.length, 2)
      assert.strictEqual(groups[0].label, 'java')
      assert.ok(groups[0].blocks.includes(javaBlock), 'primary must contain java block')
      assert.ok(groups[0].blocks.includes(sharedBlock), 'primary must contain shared block')
      assert.ok(!groups[0].blocks.includes(nodeBlock), 'primary must not contain opposite block')
      assert.strictEqual(groups[1].label, 'node')
      assert.deepStrictEqual(groups[1].blocks, [nodeBlock])
    })

    it('should return only one labelled primary group when there are no opposite blocks', () => {
      const b1 = para('Java detail one.', 'java')
      const b2 = para('Java detail two.', 'java')
      const groups = splitByRuntime([b1, b2], 'Java Events')

      assert.strictEqual(groups.length, 1)
      assert.strictEqual(groups[0].label, 'java')
      assert.deepStrictEqual(groups[0].blocks, [b1, b2])
    })

    it('should work symmetrically for a node heading, placing java blocks in the opposite group', () => {
      const nodeBlock = para('Node.js content.', 'node')
      const javaBlock = para('Java content.', 'java')
      const groups = splitByRuntime([nodeBlock, javaBlock], 'Node.js Events')

      assert.strictEqual(groups.length, 2)
      assert.strictEqual(groups[0].label, 'node')
      assert.ok(groups[0].blocks.includes(nodeBlock))
      assert.strictEqual(groups[1].label, 'java')
      assert.deepStrictEqual(groups[1].blocks, [javaBlock])
    })
  })

  describe('when no heading runtime is set but both runtimes are present', () => {
    it('should produce one java group and one node group', () => {
      const javaBlock = para('Java content.', 'java')
      const nodeBlock = para('Node.js content.', 'node')
      const groups = splitByRuntime([javaBlock, nodeBlock], 'Events')

      assert.strictEqual(groups.length, 2)
      assert.strictEqual(groups[0].label, 'java')
      assert.strictEqual(groups[1].label, 'node')
    })

    it('should exclude a pure java block from the node group and a pure node block from the java group', () => {
      const javaBlock = para('Java content.', 'java')
      const nodeBlock = para('Node.js content.', 'node')
      const groups = splitByRuntime([javaBlock, nodeBlock], 'Events')

      assert.strictEqual(groups[0].blocks.length, 1)
      assert.strictEqual(groups[0].blocks[0], javaBlock)
      assert.strictEqual(groups[1].blocks.length, 1)
      assert.strictEqual(groups[1].blocks[0], nodeBlock)
    })

    it('should project a mixed block so the java group gets java text and the node group gets node text', () => {
      const jText = 'Java specific text.'
      const nText = 'Node.js specific text.'
      const block = mixedBlock(jText, nText)
      const groups = splitByRuntime([block], 'Events')

      assert.strictEqual(groups.length, 2)
      assert.strictEqual(groups[0].label, 'java')
      assert.strictEqual(groups[0].blocks[0].text, jText)
      assert.strictEqual(groups[1].label, 'node')
      assert.strictEqual(groups[1].blocks[0].text, nText)
    })
  })

  describe('when only one runtime is present', () => {
    it('should return one labelled group when all blocks are java', () => {
      const b1 = para('Java content one.', 'java')
      const b2 = para('Java content two.', 'java')
      const groups = splitByRuntime([b1, b2], 'Events')

      assert.strictEqual(groups.length, 1)
      assert.strictEqual(groups[0].label, 'java')
      assert.deepStrictEqual(groups[0].blocks, [b1, b2])
    })

    it('should add a second unlabelled group for shared content when there is a non-pure block alongside java', () => {
      const javaBlock = para('Java content.', 'java')
      const sharedBlock = para('Shared content.') // not pure java — no runtime at all
      const groups = splitByRuntime([javaBlock, sharedBlock], 'Events')

      assert.strictEqual(groups.length, 2)
      assert.strictEqual(groups[0].label, 'java')
      assert.deepStrictEqual(groups[0].blocks, [javaBlock, sharedBlock])
      assert.strictEqual(groups[1].label, undefined)
      assert.deepStrictEqual(groups[1].blocks, [sharedBlock])
    })

    it('should not emit a second group when all blocks are pure java', () => {
      const b1 = para('Java text.', 'java')
      const groups = splitByRuntime([b1], 'Events')

      assert.strictEqual(groups.length, 1)
    })
  })

  describe('when no runtime is present', () => {
    it('should return a single group with label undefined when blocks have no runtime', () => {
      const b1 = para('Generic content one.')
      const b2 = para('Generic content two.')
      const groups = splitByRuntime([b1, b2], 'Events')

      assert.strictEqual(groups.length, 1)
      assert.strictEqual(groups[0].label, undefined)
      assert.deepStrictEqual(groups[0].blocks, [b1, b2])
    })

    it('should treat an empty heading as no heading runtime', () => {
      const b1 = para('Generic content.')
      const groups = splitByRuntime([b1], '')

      assert.strictEqual(groups.length, 1)
      assert.strictEqual(groups[0].label, undefined)
    })

    it('should fall through to block scan when heading contains both Java and Node.js', () => {
      // "Java and Node.js" contains both → detectRuntime returns null
      const javaBlock = para('Java only content.', 'java')
      const nodeBlock = para('Node.js only content.', 'node')
      const groups = splitByRuntime([javaBlock, nodeBlock], 'Java and Node.js Events')

      // Both runtimes present in blocks → split into two groups
      assert.strictEqual(groups.length, 2)
      assert.strictEqual(groups[0].label, 'java')
      assert.strictEqual(groups[1].label, 'node')
    })
  })
})
