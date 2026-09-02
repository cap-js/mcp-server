import { resolveIds } from './ids.js'
import tools from '../../lib/tools.js'

export async function makeSearchDocsRunner(k, sourceMap) {
  const retrieve = async function (question, time) {
    const out = await tools.search_docs.handler({ query: question, maxResults: k })
    return resolveIds(out ? out.split('\n---\n') : [], sourceMap)
  }
  return retrieve
}
