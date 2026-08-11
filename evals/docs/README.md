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
  config.json          # single source of all config (committed) — see "Configuration"
  bin/                 # thin CLI entry files invoked by the npm scripts
    eval.js            #   `npm run evals`         → evaluateAndCompare()
    compare.js         #   `npm run evals:compare` → compare()
  lib/                 # implementation (imported by bin/ and the tests)
    config.js          #   config loader (config.json + EVAL_* env overrides)
    evaluate.js        #   evaluate(): orchestration — load → preflight → retrieve → score → append
    compare.js         #   compare(): chart every run's metrics into an HTML dashboard
    store.js           #   result.jsonl read/append (cap to keepRuns) + baseline = oldest run
    report.js          #   pure core: buildReport, diagnose, worstQuestions, console render
    metrics.js         #   pure metric math (Recall@K, Precision@K, MRR, Hit-Rate@K, nDCG@K)
    ids.js             #   parse doc id (the Source: URL) from a chunk's first line
    search-docs.js     #   index loader + adapter for the search_docs tool under test; pluggable
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
      metrics.test.js  runner.test.js  config.test.js  ids.test.js  cli.test.js  compare.test.js
```

## Run

From the repo root (`@cap-js/mcp-server`):

```sh
npm run evals            # run the eval → appends to result.jsonl, then compares
npm run evals:compare    # (re)build the comparison report from result.jsonl
npm run evals:test       # unit + determinism + config tests
```

`npm run evals` runs the eval once (each run appended to
`runs/result.jsonl`) and **always builds the comparison report afterwards**
(`runs/compare.html`, or `compare.md` when `compareFormat: md`). Each run appends one line (its JSON report) to
**`runs/result.jsonl`**, which is capped
to the most recent `output.keepRuns` runs. Every run is compared against the **oldest
run on file** (the baseline) — the first run has no baseline and becomes the reference.
The terminal shows the summary + the 3
weakest questions; `evals:compare` charts all runs. There is no per-run folder and no markdown report.

### Compare runs (`evals:compare`)

Reads every run in `runs/result.jsonl`, ordered chronologically by run_id, and writes a
comparison report whose format is set by `output.compareFormat` in `config.json`:

- **`html`** (default) → `runs/compare.html`: one line chart per metric (Recall@K,
  Precision@K, MRR, Hit-Rate@K, nDCG@K) plotting its aggregate value across all runs (gate
  threshold as a dashed line on gated metrics, below-gate points in red), a per-question
  sparkline grid (all 5 metrics per question across runs), and a per-run drill-down
  (click a run to expand its aggregate + per-question tables). Self-contained, no
  dependencies, dark-mode aware, hover for exact values.
- **`md`** → `runs/compare.md`: the same data as GitHub-flavored markdown tables (no
  charts) — an aggregate metric×run matrix, a per-question×run matrix per metric, and a
  per-run drill-down section each with aggregate + per-question tables.

```sh
npm run evals:compare   # format from config.json (html default; set output.compareFormat: "md" for markdown)
```

It reads only `result.jsonl` — running it never triggers an eval.

The eval **always runs the retriever offline** — it scores against the already-downloaded
chunk embeddings + model and never re-fetches the corpus during a run (that would break
determinism). So the cache (`embeddings/code-chunks.*` and the ONNX model under
`models/`) **must already exist**: on a fresh checkout, run any `search_docs` query once
(online) to populate it, then all eval runs work against that frozen snapshot.

## Configuration

All behaviour lives in [`config.json`](../config.json) — edit it in one place. Two
env vars are honoured for day-to-day runs, and everything is also overridable
programmatically via `evaluate({ overrides })` in `lib/evaluate.js` (overrides win last).

| `config.json` key | Default | Meaning |
|---|---|---|
| `k` | `5` | Cutoff K for all @K metrics. Change it and clear `runs/` (K and the baseline are coupled). |
| `capire_version` | `2026.5.0` | capire docs version, recorded in the report for provenance. |
| `label` | _(unset)_ | Human-readable tag shown in reports to tell runs apart. Also settable via `EVAL_LABEL`. Display-only. |
| `baselineRunId` | _(unset)_ | Pin the baseline to a specific `run_id`. Unset → baseline is the oldest run on file. |
| `paths.goldenSet` | `data/golden-set.json` | Path to the golden set (relative to `evals/`, or absolute). |
| `paths.runsDir` | `runs` | Directory for run output. Also settable via `EVAL_RUNS_DIR` to score another corpus' results. |
| `gates.<metric>` | see file | Per-metric gate threshold (number in `[0,1]`) or `null` (reported only). |
| `output.keepRuns` | `20` (file ships `100`) | Max runs to keep in `result.jsonl` — `-1` = all, else a positive integer. |
| `output.resultsName` | `result.jsonl` | Name of the append-only results file. |
| `output.compareFormat` | `html` | `evals:compare` output: `html` (charts) or `md` (tables). |

Only `EVAL_LABEL` and `EVAL_RUNS_DIR` are read from the environment (they're what
multi-corpus experiments vary run-to-run). Everything else is edited in `config.json`.

### Useful commands

```sh
# Run with a human-readable label (shows in compare.html leaderboard)
EVAL_LABEL="my-experiment" npm run evals

# Point at a different corpus' results directory
EVAL_RUNS_DIR=runs-xenova npm run evals
EVAL_RUNS_DIR=runs-pplx  npm run evals

# Build compare.html from any result.jsonl
node evals/bin/compare.js --runs runs-xenova/result.jsonl
node evals/bin/compare.js --runs runs-xenova/result.jsonl --out runs-xenova/compare.html
```


> **K and the baseline are coupled.** When you change `k`, clear `runs/` first — the
> baseline is the oldest run on file, so mixing different-K runs produces misleading
> deltas.

> **The default gates are aspirational.** The golden set labels canonical reference pages;
> the retriever is release-notes-biased and currently scores ~Recall 0.65 / MRR 0.60 /
> Hit-Rate 0.80, so `npm run evals` **fails on Recall by design**. This is a real quality
> gap, not a broken harness. Raise retrieval quality (or lower the gates consciously) to
> turn it green.

## Outputs

Each run **appends one line** to `runs/result.jsonl` — the run's JSON report, matching
an exact contract (`run_id`, `config`, `aggregate` with
`value`/`baseline`/`delta`/`gate`/`status`, `overall_status`, `gated_failures`,
code-derived `diagnosis`, `per_question` sorted by `id`). Aggregate values are rounded
to 2 dp; per-question to 3 dp.

The **console** prints a summary (header, metrics table with trend arrows and
gate/status icons, diagnosis, result line, and the 3 weakest questions). Chart all
runs (including per-question trends) with `evals:compare`.