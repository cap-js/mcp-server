import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers'

const RERANK_MODEL = process.env.CDS_MCP_RERANK_MODEL ?? 'Xenova/ms-marco-MiniLM-L-12-v2'

let _reranker = null

export async function getReranker() {
  if (!_reranker) _reranker = Promise.all([
    AutoTokenizer.from_pretrained(RERANK_MODEL),
    AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: 'q8' }),
  ])
  return _reranker
}

export async function rerank(query, results, topK) {
  const [tokenizer, model] = await getReranker()
  const { logits } = await model(tokenizer(
    results.map(() => query),
    { text_pair: results.map(r => r.content), padding: true, truncation: true }
  ))
  return results
    .map((r, i) => ({ ...r, score: logits.data[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
