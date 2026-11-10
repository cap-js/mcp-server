import { mock } from 'node:test'

const writer = new URL('../../lib/calculateEmbeddings.js', import.meta.url)
const tokenizer = new URL('../../lib/markdownEmbeddings/chunker/tokenizer.js', import.meta.url)

mock.module(writer.href, {
  namedExports: {
    getActiveModel: () => 'fixture/default-model',
    createEmbeddings: async (id, chunks, canonical, options) => {
      process.stdout.write(`${JSON.stringify({ id, chunks, canonical, options })}\n`)
    }
  }
})
mock.module(tokenizer.href, {
  namedExports: {
    createTokenMeasure: async () => ({ measure: (text) => text.length, maxTokens: 1024 })
  }
})
