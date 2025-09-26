import getModel from './getModel.js'
import { searchEmbeddings } from './embeddings.js'

export default async function searchModel(projectPath, name, kind, topN, namesOnly) {
  const model = await getModel(projectPath)
  const defs = kind ? Object.values(model.definitions).filter(v => v.kind === kind) : Object.values(model.definitions)
  const results = (await searchEmbeddings(name, defs)).slice(0, topN)
  if (namesOnly) return results.map(r => r.name)
  return results
}
