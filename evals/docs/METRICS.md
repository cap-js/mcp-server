# CAP MCP RAG — Eval Metrics

Deterministic, code-only retrieval evaluation for the CAP MCP server's `search_docs`
RAG pipeline. Every metric is pure arithmetic computed from a frozen golden set whose
relevance labels are authored once by a human and stored in `relevant_doc_ids`. No LLM
is involved in scoring.

## The setup every metric shares

For one golden question we have:

- **`relevant`** — the set of doc ids a human judged relevant to that question
  (`relevant_doc_ids`). Call its size `R = |relevant|`.
- **`retrieved`** — the retriever's ranked list of doc ids, best first. We only look at
  the top **K** of them (`K` is configurable, default 5).
- **`hits`** — the relevant docs that made it into the top-K: `relevant ∩ top-K`.

Every metric below is a different, deliberately simple question about those `hits` and
*where* they landed. Each is computed **per question**, then **averaged (arithmetic
mean) over the golden set** to give the aggregate value you see in the report.

Running example used throughout — question `cap-001`, `K = 5`:

```
relevant  = { compositions, managed-compositions }          (R = 2)
retrieved = [ associations,        # rank 1  ✗
              compositions,        # rank 2  ✓  ← first hit
              domain-modeling,     # rank 3  ✗
              managed-compositions,# rank 4  ✓
              entities ]           # rank 5  ✗
hits at ranks 2 and 4
```

## The metrics

### Recall@K — *did we retrieve the relevant docs at all?*

**Formula:** `Recall@K = |relevant ∩ top-K| / |relevant|`

**Why it makes sense.** This is the most fundamental retrieval question: of everything a
human said was relevant, what fraction actually showed up in the top-K the model
returned? If a relevant chunk never appears, nothing downstream — ranking, the LLM's
answer — can use it. Recall is the ceiling on how good the pipeline can possibly be.

**A drop means** the right chunk isn't being *retrieved* at all → a **chunking or
embedding** problem (bad chunk boundaries, a weak embedding for that topic), not a
ranking problem.

**Example:** both relevant docs are in the top 5, so `Recall@5 = 2/2 = 1.00`. If only
`compositions` had been retrieved, it would be `1/2 = 0.50`.

### Precision@K — *how much of the top-K is actually useful?*

**Formula:** `Precision@K = |relevant ∩ top-K| / K`

**Why it makes sense.** Recall ignores the junk; precision measures it. Of the K results
we hand back (and pay context-window tokens for), what fraction is relevant? Low
precision means the model is padding the top-K with noise, which costs tokens and can
distract a downstream LLM even when recall is fine. We divide by **K**, not by the
number of results returned — returning fewer than K docs is penalised, because a short
list that happens to be clean shouldn't score the same as a full, clean one.

**A drop means** the top-K is being **padded with irrelevant docs** (noise), typically
after a change that loosened ranking or added lower-quality chunks.

**Example:** 2 of the 5 returned are relevant, so `Precision@5 = 2/5 = 0.40`.

### MRR — *how high is the first relevant doc ranked?*

**Formula:** `MRR = 1 / rank(first relevant doc in top-K)`, or `0` if none is in top-K.
(MRR = *Mean* Reciprocal Rank once averaged across questions.)

**Why it makes sense.** Recall and precision are *set* metrics — they don't care about
order. But order matters: a relevant doc at rank 1 is far more useful than the same doc
at rank 5 (an LLM reads top-down and may be cut off by a context budget). The reciprocal
rank rewards putting *a* relevant doc as high as possible, and it falls off steeply
(1, ½, ⅓, ¼, …) so the difference between rank 1 and rank 3 is large and between rank 8
and rank 9 is tiny — which matches how much rank actually matters to a reader.

**A drop means** relevant chunks are still being retrieved (recall holds) but are ranked
**lower** → a **ranking / scoring** regression, not a chunking one. This recall-stable /
MRR-down pattern is exactly what the diagnosis rule keys on.

**Example:** the first relevant doc is at rank 2, so `MRR = 1/2 = 0.50`. If it had been
at rank 1, `MRR = 1.00`.

### Hit-Rate@K — *did we get at least one relevant doc? (the pass@k stand-in)*

**Formula:** `Hit-Rate@K = 1` if `|relevant ∩ top-K| ≥ 1`, else `0`.

**Why it makes sense.** This is the cheapest, most binary signal: did the retrieval
"work at all" for this question? Averaged over the golden set it's the fraction of
questions where the model surfaced *something* relevant in the top-K — a good smoke-test
/ CI tripwire that's easy to reason about and hard to game.

**Relationship to `pass@k`.** `pass@k` (from agentic evals) means "give the system k
attempts, count success if any attempt succeeds" — it needs a *success oracle* to judge
each attempt. With **no LLM judge** and a **deterministic** retriever (k identical
attempts), the only honest, computable notion of "an attempt succeeded" is "a relevant
doc was retrieved" — which is precisely **Hit-Rate@K**. So there is deliberately no
separate `pass@k` metric or LLM call; `pass@k` collapses into Hit-Rate@K here.
(It differs from Recall@K only when a question has multiple relevant docs: Hit-Rate asks
"≥1?", Recall asks "what fraction?".)

**Example:** at least one relevant doc is in the top 5, so `Hit-Rate@5 = 1`.

### nDCG@K — *is the whole ranking well-ordered, not just the first hit?*

**Formula (binary relevance):**

```
DCG@K  = Σ_{i=1..K}  rel_i / log2(i + 1)      # rel_i ∈ {0,1}; i is the 1-based rank
IDCG@K = DCG@K of the ideal ordering          # all relevant docs first
nDCG@K = DCG@K / IDCG@K                        # 0 if the question has no relevant docs
```

**Why it makes sense.** MRR only looks at the *first* relevant doc; nDCG grades the
*entire* top-K ordering. Each relevant doc contributes a gain discounted by its rank
(`1/log2(rank+1)`), so hits lower down still count but count less. Normalising by the
ideal DCG (what you'd get if every relevant doc were packed at the top) puts it on a
0–1 scale where **1.0 means "perfectly ordered"** regardless of how many relevant docs
the question has. It's the most complete ranking-quality signal, which is why we report
it — but it needs graded relevance to shine, so with our binary labels it mostly
corroborates MRR.

**A drop means** the ordering degraded even if the retrieved *set* is unchanged →
**ranking / scoring**, same family as MRR.

**Example:** hits at ranks 2 and 4 →
`DCG = 1/log2(3) + 1/log2(5) = 0.6309 + 0.4307 = 1.0616`;
ideal (ranks 1 and 2) `IDCG = 1/log2(2) + 1/log2(3) = 1.0 + 0.6309 = 1.6309`;
`nDCG@5 = 1.0616 / 1.6309 ≈ 0.651`.

## How the metrics work together

They're layered on purpose — reading them side by side localises a regression to a
pipeline stage without any guessing:

| Question the metric answers | Metric | Cares about rank? |
|---|---|:--:|
| Were the relevant docs retrieved at all? | Recall@K | no |
| Is the top-K free of noise? | Precision@K | no |
| Did we get at least one? (pass@k) | Hit-Rate@K | no |
| How high is the first relevant doc? | MRR | yes (first hit) |
| Is the whole ordering good? | nDCG@K | yes (all hits) |

The **set** metrics (Recall, Precision, Hit-Rate) tell you *what* was found; the
**rank** metrics (MRR, nDCG) tell you *where*. A regression in the first group points at
chunking/embedding; a regression only in the second points at ranking/scoring.

### Diagnosis (code-derived, first match wins)

The runner turns that logic into a single diagnosis string, from the aggregate deltas
vs. the baseline:

1. Recall down → `recall_down → chunking/embedding regression`
   *(the relevant docs stopped being retrieved — a set problem)*
2. Recall stable/up but MRR or nDCG down → `recall_stable_mrr_down → ranking/scoring regression`
   *(same docs retrieved, ranked worse — a rank problem)*
3. Recall & MRR ok but Precision down → `precision_down → top-K padded with noise`
   *(still finding + ranking the good ones, but adding junk around them)*
4. Nothing regressed → `no_regression`

## Gated vs. reported metrics

- **Gated** (a drop below threshold fails the run, non-zero exit): `recall_at_k`, `mrr`, `hit_rate_at_k`.
- **Reported only** (`gate: null`, never fails the run): `precision_at_k`, `ndcg_at_k`.

Recall, MRR, and Hit-Rate are gated because they map most directly to "is retrieval doing
its job" and to a clear failure mode. Precision and nDCG are reported for diagnosis but
not gated — Precision because top-K noise is often an acceptable trade for recall, and
nDCG because with binary labels it largely tracks MRR (revisit once graded relevance
exists).

Thresholds live in `config.json` (`gates`) and are **derived empirically from a baseline
run** — they are not hardcoded "industry standard" numbers. The baseline is the oldest
run in `runs/result.jsonl`; run the eval on a known-good state, read its metric values,
and set each gate at/below them with a small margin.

## Doc identity (why URL + breadcrumb, not chunk index)

The corpus re-indexes and chunk array positions shift, so ground truth must NOT be
keyed on the array index. Instead we derive a deterministic id by **parsing the chunk's
first line** — no embeddings, no hashing:

```
docId = "<source-url>#<breadcrumb-slug>"
```

A chunk's first line looks like
`CDS Language & Compiler > Managed Compositions … > Source: https://cap.cloud.sap/docs/releases/2020/july20`,
which parses to
`https://cap.cloud.sap/docs/releases/2020/july20#cds-language-compiler-managed-compositions-for-improved-domain-modeling`.

- The **Source: URL** is the page identity — stable across a re-index.
- The **breadcrumb slug** adds section granularity, so distinct sections of the same
  page are distinct ids (e.g. two `#…authorization…` sections under one auth page).
- Chunks with a breadcrumb but no `Source:` URL get `nourl#<slug>`; a chunk with neither
  is unidentifiable and dropped from retrieval.

This scheme is fully **deterministic** (pure string parsing). Only the *rank order* of
retrieved docs comes from the embedding retriever; the identity used for matching never
touches embeddings. Because many chunks share a page URL, the retriever **dedups**
retrieved ids keeping best rank, so `retrieved_ids` is a ranked list of distinct docs.

`relevant_doc_ids` (golden set) and `retrieved_ids` (retriever output) are both in this
id space. The implementation is in `lib/ids.js` (`parseId`, `buildIdMap`).

### Consequence for re-index / golden-set refresh

If a page's **URL or breadcrumb** changes, its id changes. The **pre-flight check** in
the runner verifies every `relevant_doc_id` still exists in the current index and aborts
loudly (listing the stale ids) if not — so a re-index that moves a labelled page fails
fast instead of silently scoring against dead labels. Refresh procedure is in `README.md`.