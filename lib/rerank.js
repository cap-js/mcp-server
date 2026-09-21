import { pipeline } from '@huggingface/transformers'

const RERANK_MODEL = process.env.CDS_MCP_RERANK_MODEL ?? 'Xenova/ms-marco-MiniLM-L-6-v2'

let _reranker = null

export async function getReranker() {
  if (!_reranker) _reranker = pipeline('text-classification', RERANK_MODEL)
  return _reranker
}

function buildDocument(r) {
  if (!r.meta) return r.content
  const header = Object.entries(r.meta)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return header ? `${header}\n\n${r.content}` : r.content
}

export async function rerank(query, results, topK) {
  const reranker = await getReranker()
  const pairs = results.map(r => ({ text: query, text_pair: buildDocument(r) }))
  const scores = await reranker(pairs)
  return results
    .map((r, i) => {
      const s = scores[i]
      // For binary classifiers LABEL_0 = not-relevant; invert so higher = more relevant
      const score = s.label === 'LABEL_0' ? 1 - s.score : s.score
      return { ...r, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
