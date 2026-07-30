# CAP MCP RAG — Eval Metrics

Deterministic, code-only retrieval evaluation for the CAP MCP server's `search_docs`
RAG pipeline. Every metric is pure arithmetic computed from a frozen golden set whose relevance labels are
authored once by a human and stored in `relevant_doc_ids`.

## Why these metrics (issue TODO #1 — alternatives to pass@k)

`pass@k` in the sense of "did an agent complete the task in k attempts" requires a
correctness oracle. **Hit-Rate@K** — "did at least one relevant doc appear in the top-K?".
Instead we compute the standard information-retrieval metrics, which also let us attribute a
regression to a specific stage of the pipeline:

| Metric | Formula (binary relevance) | What a drop tells you |
|---|---|---|
| **Recall@K** | `|relevant ∩ top-K| / |relevant|` | The right chunk isn't being retrieved at all → **chunking / embedding** regression |
| **Precision@K** | `|relevant ∩ top-K| / K` | Top-K is padded with irrelevant docs → **noise / padding** |
| **MRR** | `1 / rank(first relevant)`, `0` if none in top-K | Relevant chunk retrieved but ranked lower → **ranking / scoring** regression |
| **Hit-Rate@K** | `1` if `≥1` relevant in top-K else `0` | Cheapest smoke signal; subsumes "pass@k" without a judge |
| **nDCG@K** | `DCG@K / IDCG@K`, binary gains | Ordering degraded even if the set is right → **ranking / scoring** |

`DCG@K = Σ_{i=1..K} rel_i / log2(i + 1)` (rank `i` is 1-based; `rel_i ∈ {0,1}`).
`IDCG@K` is `DCG@K` of the ideal ordering (all relevant docs first). `nDCG@K = 0`
when the question has no relevant docs in the index (should never happen — see the
pre-flight check).

Each metric is computed **per question** and then **averaged (arithmetic mean)** over
the golden set to produce the aggregate.

### Diagnosis (code-derived, first match wins)

From the aggregate deltas vs. the baseline:

1. Recall down → `recall_down → chunking/embedding regression`
2. Recall stable/up but MRR or nDCG down → `recall_stable_mrr_down → ranking/scoring regression`
3. Recall & MRR ok but Precision down → `precision_down → top-K padded with noise`
4. Nothing regressed → `no_regression`

## Gated vs. reported metrics

- **Gated** (a drop below threshold fails the run, non-zero exit): `recall_at_k`, `mrr`, `hit_rate_at_k`.
- **Reported only** (`gate: null`, never fails the run): `precision_at_k`, `ndcg_at_k`.

Thresholds live in `config.json` (`gates`) and are **derived empirically from a baseline
run** — they are not hardcoded "industry standard" numbers. The baseline is the oldest
run in `runs/result.jsonl`; run the eval on a known-good state, read its metric values,
and set each gate at/below them with a small margin.

## Stable identifiers (why not chunk index)

The corpus re-indexes and chunk array positions shift, so ground truth must NOT be
keyed on the array index. The chunk store has no built-in id, so we derive a stable id
from the chunk **content**:

```
docId = "<label>#<sha1(text)[:8]>"
```

- `sha1(text)[:8]` is the identity: deterministic, collision-free across distinct
  chunks, and stable under reordering (same text → same id, wherever it lands).
- `<label>` is a readable slug from the chunk's first-line breadcrumb
  (e.g. `serving-provided-services-cds-serve#1a2b3c4d`), for human-friendly reports.
  It does not affect identity.

`relevant_doc_ids` (golden set) and `retrieved_ids` (retriever output) are both in this
id space. The implementation is in `lib/ids.js` (`docIdFor`, `buildIdMap`).

### Consequence for re-index / golden-set refresh

If a chunk's **text** changes, its id changes. The **pre-flight check** in the runner
verifies every `relevant_doc_id` still exists in the current index and aborts loudly
(listing the stale ids) if not — so a corpus re-index that alters labelled chunks fails
fast instead of silently scoring against dead labels. Refresh procedure is in `README.md`.

## Determinism guarantees (hard requirements)

- No LLM calls, no randomness, no wall-clock in metric computation.
- `run_id` (an ISO timestamp + short suffix) is the **only** nondeterministic field;
  it is stamped after computation / passed in, so it never affects any metric.
- Same golden set + same retriever output → **byte-identical** JSON (except `run_id`)
  and byte-identical console body. This is asserted by a test (`tests/unit/runner.test.js`).
- The default retriever embeds with `Xenova/all-MiniLM-L6-v2` (the production model in
  `lib/calculateEmbeddings.js`). It is fixed, not a config knob — scoring against the
  pre-built `code-chunks.bin` only makes sense with the model that built it. Evaluate on
  **our** corpus — do not substitute MTEB leaderboard aggregates.
