import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers'

const RERANK_MODEL = process.env.CDS_MCP_RERANK_MODEL ?? 'Xenova/ms-marco-MiniLM-L-12-v2'

let _reranker = null

export async function getReranker() {
  if (!_reranker) _reranker = Promise.all([
    AutoTokenizer.from_pretrained(RERANK_MODEL),
    AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: 'q8' }),
  ]).catch(e => { throw new Error(
    `Failed to load reranker model "${RERANK_MODEL}". Set CDS_MCP_RERANK_MODEL to a supported model, e.g.:\n` +
    `  Xenova/ms-marco-MiniLM-L-12-v2\n` +
    `  Xenova/ms-marco-MiniLM-L-6-v2\n` +
    `  Xenova/ms-marco-TinyBERT-L-2-v2\n` +
    `  mixedbread-ai/mxbai-rerank-xsmall-v1\n` +
    `  mixedbread-ai/mxbai-rerank-base-v1\n` +
    `  jinaai/jina-reranker-v1-tiny-en`,
    { cause: e }
  ) })
  return _reranker
}

export async function rerank(query, results, topK) {
  const [tokenizer, model] = await getReranker()
  const scores = []
  const rerankBatchSize = 1
  for (let i = 0; i < results.length; i += rerankBatchSize) {
    const batch = results.slice(i, i + rerankBatchSize)
    const features = tokenizer(
      batch.map(() => query),
      { text_pair: batch.map(r => r.content), padding: true, truncation: true }
    )
    const { logits } = await model(features)
    scores.push(...logits.data.slice(0, batch.length))
  }
  return results
    .map((r, i) => ({ ...r, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
