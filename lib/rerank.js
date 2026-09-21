import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers'

const RERANK_MODEL = process.env.CDS_MCP_RERANK_MODEL ?? 'Xenova/ms-marco-MiniLM-L-6-v2'

let _reranker = null

export async function getReranker() {
  if (!_reranker) _reranker = Promise.all([
    AutoTokenizer.from_pretrained(RERANK_MODEL),
    AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL),
  ])
  return _reranker
}

export async function rerank(query, results, topK) {
  const [tokenizer, model] = await getReranker()
  const queries = results.map(() => query)
  const docs = results.map(r => r.content)
  // TextClassificationPipeline applies softmax which collapses a single-logit model to 1.0 always.
  // Use the low-level API to get the raw logit — higher logit = more relevant for ms-marco models.
  const inputs = tokenizer(queries, { text_pair: docs, padding: true, truncation: true })
  const { logits } = await model(inputs)
  return results
    .map((r, i) => ({ ...r, score: logits.data[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
