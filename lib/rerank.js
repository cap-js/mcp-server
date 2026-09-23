import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers'

const RERANK_MODEL = process.env.CDS_MCP_RERANK_MODEL ?? 'Xenova/ms-marco-MiniLM-L-12-v2'
const RERANK_DTYPE = process.env.CDS_MCP_RERANK_DTYPE ?? undefined
const RERANK_EXTERNAL_DATA = process.env.CDS_MCP_RERANK_EXTERNAL_DATA === 'true' || undefined

let _reranker = null

export async function getReranker() {
  if (!_reranker) _reranker = Promise.all([
    AutoTokenizer.from_pretrained(RERANK_MODEL),
    AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: RERANK_DTYPE, use_external_data_format: RERANK_EXTERNAL_DATA }),
  ]).catch(e => { throw new Error(
    `Failed to load reranker model "${RERANK_MODEL}". ` +
    `The model must be a cross-encoder (sequence classification) with ONNX files and a model_type in config.json.\n` +
    `For models without model_quantized.onnx set CDS_MCP_RERANK_DTYPE=fp32.\n` +
    `For models with external weight files (.onnx_data) set CDS_MCP_RERANK_EXTERNAL_DATA=true.`,
    { cause: e }
  ) })
  return _reranker
}

export async function rerank(query, results, topK) {
  const [tokenizer, model] = await getReranker()
  const scores = []
  const rerankBatchSize = 10
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
