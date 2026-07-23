# Evaluating the CAP MCP Server

> Status: initial scaffold. See [cap/cdsnode#2764](https://github.tools.sap/cap/cdsnode/issues/2764).

We cannot justify _any_ change to the server (better embedding model, hybrid
search, verbatim docs, new tools) without a way to measure whether it helps.
This directory is that measuring stick.

There are **two independent levels** of evaluation. Do not conflate them.

| Level | Question it answers | Cost | Runs where |
|-------|--------------------|------|------------|
| **A — Retrieval** | Does `search_docs` return the _right_ doc for a query? | cents, seconds | CI gate |
| **B — End-to-end (agentic)** | Does an AI agent build CAP apps _better_ with the server than without? | \$\$, minutes | on demand / nightly |

Level A is a pure information-retrieval benchmark with deterministic metrics —
it gates PRs. Level B is a task-completion benchmark that produces the
"is it worth it?" narrative for stakeholders, comparing arms:

- **`none`** — agent with no MCP, no skills (base model + file access only)
- **`llms-txt`** — agent with only a pointer to [`llms.txt`](https://cap.cloud.sap/docs/llms.txt)
  + web fetch (the cheapest doc access — an llmstxt.org index, no server)
- **`skills`** — agent with [capire/skills](https://github.com/capire/skills) but **no MCP**
  (the "structured guidance without the server" competitor)
- **`mcp`** — agent with the cds-mcp server
- **`mcp+skills`** — both (the intended production setup)

The headline we want:

> _With cds-mcp, agents complete **X%** more CAP tasks at **Y%** lower token
> cost and produce **Z%** fewer deprecated-API usages than the skills-only and
> no-help baselines._

---

## Level A — Retrieval eval

Lives in [`retrieval/`](retrieval/). Runnable, no LLM required for scoring.

```sh
npm run eval:retrieval
```

### How it works

1. A golden set ([`retrieval/golden.jsonl`](retrieval/golden.jsonl)) maps a
   natural-language query to the doc page(s) that _should_ be retrieved,
   identified by a substring of their source URL (the `Source:` line every
   chunk carries).
2. The runner embeds each query with the **same** local model the server uses
   ([`../lib/embeddings.js`](../lib/embeddings.js)) and ranks all chunks by
   cosine similarity — i.e. it exercises the real retrieval path.
3. It computes standard IR metrics against the ground truth.

### Metrics

- **Recall@k** (k = 1, 3, 5, 10) — is a relevant chunk in the top-k? _Primary._
- **MRR** — mean reciprocal rank of the first relevant hit.
- **nDCG@10** — rank quality.
- **Latency** p50/p95 per query.
- **Pollution rate** — fraction of top-5 results sourced from
  `releases/` / release notes (directly measures [#2764](https://github.tools.sap/cap/cdsnode/issues/2764)).

### The regression gate

`npm run eval:retrieval` prints a table and writes
`retrieval/results/latest.json`. Wire it into CI as a **report** first, then a
**gate** once the baseline is trusted (fail the build if Recall@5 drops more
than N points vs. the committed baseline). This is where you _prove_ a change:

> `MiniLM → bge-small-en-v1.5` lifts Recall@5 from 0.68 → 0.84
> Adding BM25 hybrid adds +9 pts on keyword-heavy queries

### Growing the golden set

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

---

## Level B — End-to-end agentic eval

Design + skeleton in [`e2e/`](e2e/). See [`e2e/README.md`](e2e/README.md) for
the full harness design, arm definitions, and how it reuses the eval convention
already established in `capire/skills` (`evals.json` + fixtures).

The short version:

- A **task suite** of realistic CAP tasks, each with **machine-checkable**
  success criteria (`cds compile` exits 0, entity exists in CSN, scripted HTTP
  request returns 400, seeded broken project builds again) — not LLM vibes,
  wherever possible.
- Each task runs in each **arm** (`none` / `skills` / `mcp` / `mcp+skills`),
  N times (agents are stochastic — report pass _rate_).
- Per-arm metrics: **task success rate** (primary), **tokens/\$/turns**,
  **deprecated-API usage**, **flailing** (redundant file reads / retries).

---

## Recommended sequence

1. **Land Level A** + seed golden set → CI report, then gate.
2. **Run Level B once now** → establishes the status-quo `mcp` vs `skills` vs
   `none` delta. This is your baseline "worth it" number.
3. **Hybrid search** (BM25 + semantic) → first improvement, measured on both.
4. **Verbatim docs + contextual chunks**, then **embedding-model upgrade**.
5. **`cds_compile` tool** + result metadata (source URLs/scores) → re-run B,
   expect the biggest end-to-end jump.
6. Re-run B after each change → defensible improvement curve over time.
