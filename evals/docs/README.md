# CAP MCP RAG — Deterministic Retrieval Evals

A **pure-code, fully deterministic** evaluation harness for the CAP MCP server's
`search_docs` retrieval. It scores the real retrieval path against a **frozen golden
set** with human-authored relevance labels, computes standard IR metrics by pure
arithmetic, compares against a stored baseline, applies gate thresholds, and emits a
machine-readable JSON report plus a human console summary.

See [`METRICS.md`](./METRICS.md) for metric definitions, the stable-identifier scheme,
and the determinism guarantees.

## Folder structure

```
evals/
  lib/                 # implementation (imported by the tests and npm run evals)
    config.js          #   DEFAULT_CONFIG (edit here) + config loader (EVAL_* env overrides)
    index.js           #   evaluate() + evaluateAndCompare() — orchestration
    retrieval.js       #   readJsonOrNull, makeSearchDocsRunner, retrieveAll, findEmbeddingDirs, readCapireVersion
    compare.js         #   compare(): chart every run's metrics into an HTML dashboard
    store.js           #   result.jsonl read/append (cap to keepRuns) + baseline = oldest run
    report.js          #   pure core: buildReport, diagnose, worstQuestions, console render
    metrics.js         #   pure metric math (Recall@K, MRR, Hit-Rate@K, nDCG@K)
    ids.js             #   parse doc id (the Source: URL) from a chunk's first line
    createSourceDb/    #   pipeline to build chunk embeddings from capire source docs
  data/                # committed input
    golden-set.json    #   frozen { id, question, relevant_doc_ids }; relevance authored once
  docs/
    README.md          #   this file
    METRICS.md         #   metric definitions + stable-ID scheme + determinism
  runs/                # transient run output (git-ignored; created on demand)
    result.jsonl       #   one JSON run report per line; capped to keepRuns (newest kept)
    compare.html       #   metric-trend dashboard (or compare.md if compareFormat=md)
  tests/
    unit/              # unit tests
      metrics.test.js  config.test.js  ids.test.js  evaluate.test.js  store.test.js
      compare.test.js  report.test.js  search-docs.test.js  checkScoreForDifferentTexts.test.js
```

## Run

From the repo root (`@cap-js/mcp-server`):

```sh
npm run evals        # run the eval → appends to result.jsonl, then builds compare report
npm run evals:test   # unit + determinism + config tests
```

`npm run evals` runs the eval (each run appended to
`runs/result.jsonl`) and **always builds the comparison report afterwards**
(`runs/compare.html`, or `compare.md` when `compareFormat: md`). Each run appends one line (its JSON report) to
**`runs/result.jsonl`**, which is capped
to the most recent `output.keepRuns` runs. Every run is compared against the **oldest
run on file** (the baseline) — the first run has no baseline and becomes the reference.
The terminal shows the summary + the 3
weakest questions.

### Comparison report

Built automatically at the end of every `npm run evals`. The format is controlled by
`output.compareFormat` in `DEFAULT_CONFIG` (`config.js`):

- **`html`** (default) → `runs/compare.html`: leaderboard (all runs ranked by gated
  metrics), one line chart per metric (Recall@K, MRR, Hit-Rate@K, nDCG@K)
  plotting aggregate values across all runs (gate threshold as a dashed line on gated
  metrics, below-gate points in red), a per-question sparkline grid, and a per-run
  drill-down (click a run to expand its aggregate + per-question tables). Self-contained,
  no dependencies, dark-mode aware, hover for exact values.
- **`md`** → `runs/compare.md`: the same data as GitHub-flavored markdown tables (no
  charts) — an aggregate metric×run matrix, a per-question×run matrix per metric, and a
  per-run drill-down section each with aggregate + per-question tables.

The eval **always runs the retriever offline** — it scores against the already-downloaded
chunk embeddings + model and never re-fetches the corpus during a run (that would break
determinism). So the cache (`embeddings/code-chunks.*` and the ONNX model under
`models/`) **must already exist**: on a fresh checkout, run any `search_docs` query once
(online) to populate it, then all eval runs work against that frozen snapshot.

## Configuration

All behaviour is configured in `DEFAULT_CONFIG` at the top of [`lib/config.js`](../lib/config.js) — edit it in one place. One
env var is honoured for day-to-day runs, and everything is also overridable
programmatically via `evaluate({ overrides })` in `lib/index.js` (overrides win last).

| `DEFAULT_CONFIG` key | Default | Meaning |
|---|---|---|
| `k` | `5` | Cutoff K for all @K metrics. Change it and clear `runs/` (K and the baseline are coupled). |
| `embeddingsDir` | `'../embeddings'` | Parent directory to sweep. The eval runs once per discovered leaf dir (any dir containing `code-chunks.json`), appending all results to `result.jsonl` and building one compare report. Label is derived automatically from the path segments relative to this dir. Override to `null` to disable sweep. |
| `gates.<metric>` | see file | Per-metric gate threshold (number in `[0,1]`) or `null` (reported only). |
| `output.runsDir` | `runs` | Directory for run output. |
| `output.keepRuns` | `500` | Max runs to keep in `result.jsonl` — `-1` = all, else a positive integer. |
| `output.resultsName` | `result.jsonl` | Name of the append-only results file. |
| `output.compareFormat` | `html` | `evals:compare` output: `html` (charts) or `md` (tables). |

All configuration is edited in `DEFAULT_CONFIG`.

### Useful commands

`embeddingsDir` in `DEFAULT_CONFIG` points to a parent directory. The eval discovers
every descendant directory that contains `code-chunks.json`, runs once per directory,
and appends all results to `result.jsonl`. A single `compare.html` is built at the end.

```js
// In lib/config.js DEFAULT_CONFIG:
embeddingsDir: '/path/to/All Embeddings/xenova_w_meta'
```

Labels are derived automatically from the path segments relative to `embeddingsDir`.
If `cfg.label` is also set, it is prepended: `<label>/<path/segments>`.

Given this layout:

```
xenova_w_meta/
  256-d4/
    no-meta/     ← code-chunks.json here
    with-meta/   ← code-chunks.json here
  512-d4/
    no-meta/     ← code-chunks.json here
```

Labels produced: `256-d4/no-meta`, `256-d4/with-meta`, `512-d4/no-meta`.

## Outputs

Each run **appends one line** to `runs/result.jsonl`.