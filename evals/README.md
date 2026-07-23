# Retrieval regression evals

> See [cap/cdsnode#2764](https://github.tools.sap/cap/cdsnode/issues/2764).

Local, deterministic evals for the server's `search_docs` retrieval quality.
No LLM required, run in seconds — this is a **regression gate**, not a
stakeholder benchmark.

> **End-to-end "is the MCP server worth it vs. building without it?" benchmarks**
> (agent with/without MCP, skills, llms.txt, …) live in a separate repo:
> [`cap/ai-dev-benchmark`](https://github.tools.sap/cap/ai-dev-benchmark).
> They're stochastic, cost real tokens, and depend on an agent runtime — so they
> don't belong in the published package. This directory stays fast and offline.

We cannot justify _any_ change to retrieval (better embedding model, hybrid
search, verbatim docs) without a way to measure whether it helps. This is that
measuring stick.

```sh
npm run eval:retrieval
```

## How it works

1. A golden set ([`retrieval/golden.jsonl`](retrieval/golden.jsonl)) maps a
   natural-language query to the doc page(s) that _should_ be retrieved,
   identified by a substring of their source URL (the `Source:` line every
   chunk carries).
2. The runner embeds each query with the **same** local model the server uses
   ([`../lib/embeddings.js`](../lib/embeddings.js)) and ranks all chunks by
   cosine similarity — i.e. it exercises the real retrieval path.
3. It computes standard IR metrics against the ground truth.

## Metrics

- **Recall@k** (k = 1, 3, 5, 10) — is a relevant chunk in the top-k? _Primary._
- **MRR** — mean reciprocal rank of the first relevant hit.
- **nDCG@10** — rank quality.
- **Latency** p50/p95 per query.
- **Pollution rate** — fraction of top-5 results sourced from
  `releases/` / release notes (directly measures [#2764](https://github.tools.sap/cap/cdsnode/issues/2764)).

## The regression gate

`npm run eval:retrieval` prints a table and writes
`retrieval/results/latest.json`. Wire it into CI as a **report** first, then a
**gate** once the baseline is trusted (fail the build if Recall@5 drops more
than N points vs. the committed baseline). This is where you _prove_ a change:

> `MiniLM → bge-small-en-v1.5` lifts Recall@5 from 0.68 → 0.84
> Adding BM25 hybrid adds +9 pts on keyword-heavy queries

## Growing the golden set

Aim for 150–300 items. Sources, in order of value:

1. **Real questions** — CAP Slack, GitHub issues, the "questions this server
   helps answer" list in the root README.
2. **Bootstrapped** — for each doc chunk, ask an LLM "what question does this
   answer?" Cheap way to reach a few hundred; hand-review for quality.
3. **Adversarial / keyword** — exact tokens (`@cds.persistence.skip`,
   `srv.before`, error strings) that pure semantic search tends to miss.
   These justify hybrid search.

Tag each item with `category` and `difficulty` so you can slice the report and
see _where_ a change helps or regresses.

## Improvement roadmap (what these evals will measure)

1. **Hybrid search** (BM25 + semantic) — first improvement; directly attacks the
   release-note pollution and exact-token misses.
2. **Verbatim docs + contextual chunks** (not AI summaries), then an
   **embedding-model upgrade** (MiniLM-L6 → e.g. `bge-small-en-v1.5`).
3. **Result metadata** — return source URLs/scores from `search_docs`.

Each change reruns `npm run eval:retrieval` for a defensible before/after.
