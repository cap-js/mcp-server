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
    eval.js            #   `npm run evals`         → runAll()
    compare.js         #   `npm run evals:compare` → compare()
  lib/                 # implementation (imported by bin/ and the tests)
    config.js          #   config loader (config.json + EVAL_* env overrides)
    cli.js             #   run(): orchestration — load → preflight → retrieve → score → append
    compare.js         #   compare(): chart every run's metrics into an HTML dashboard
    store.js           #   result.jsonl read/append (cap to keepRuns) + baseline = oldest run
    runner.js          #   pure core: buildReport, diagnose, worstQuestions, console render
    metrics.js         #   pure metric math (Recall@K, Precision@K, MRR, Hit-Rate@K, nDCG@K)
    ids.js             #   parse doc id from a chunk's first line  (<source-url>#<breadcrumb-slug>)
    retriever.js       #   index loader + default retriever (real search_docs path); pluggable
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
npm run evals            # run the eval config.runs× (default 1) → appends to result.jsonl, then compares
EVAL_RUNS=10 npm run evals   # run it 10 times in one go
npm run evals:compare    # (re)build the comparison report from result.jsonl
npm run evals:test       # unit + determinism + config tests
```

`npm run evals` runs the eval `config.runs` times (each run appended to
`runs/result.jsonl`) and **always builds the comparison report afterwards**
(`runs/compare.html`, or `compare.md` when `compareFormat: md`). Use `EVAL_RUNS` to
run it many times in one invocation. Each run appends one line (its JSON report) to
**`runs/result.jsonl`**, which is capped
to the most recent `output.keepRuns` runs. Every run is compared against the **oldest
run on file** (the baseline) — the first run has no baseline and becomes the reference.
The terminal shows the summary + the 3
weakest questions; `evals:compare` charts all runs. There is no per-run folder and no markdown report.

### Compare runs (`evals:compare`)

Reads every run in `runs/result.jsonl`, ordered chronologically by run_id, and writes a
comparison report whose format is set by `output.compareFormat` (`EVAL_COMPARE_FORMAT`):

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
npm run evals:compare                        # html (default)
EVAL_COMPARE_FORMAT=md npm run evals:compare  # markdown
```

It reads only `result.jsonl` — running it never triggers an eval.

The eval **always runs the retriever offline** — it scores against the already-downloaded
chunk embeddings + model and never re-fetches the corpus during a run (that would break
determinism). So the cache (`embeddings/code-chunks.*` and the ONNX model under
`models/`) **must already exist**: on a fresh checkout, run any `search_docs` query once
(online) to populate it, then all eval runs work against that frozen snapshot.

## Configuration

All behaviour is driven by [`config.json`](../config.json); every value is overridable
by an `EVAL_*` environment variable (env wins over file), and both are overridable
programmatically via `run({ overrides })` in `lib/cli.js` (overrides win last).

`config.json` holds the full set of knobs — every field is present with its default,
so you can edit any of them in one place:

| config.json key | Env override | Default | Meaning |
|---|---|---|---|
| `k` | `EVAL_K` | `5` | Cutoff K for all @K metrics. |
| `runs` | `EVAL_RUNS` | `1` | How many times `npm run evals` runs the eval (each appended). |
| `capire_version` | `EVAL_CAPIRE_VERSION` | `2026.5.0` | capire docs version, recorded in the report `config` + console header (provenance only). |
| `paths.goldenSet` | `EVAL_GOLDEN_SET` | `data/golden-set.json` | Path to the golden set (relative to `evals/`, or absolute). |
| `paths.runsDir` | `EVAL_RUNS_DIR` | `runs` | Directory for run output. |
| `gates.<metric>` | `EVAL_GATES` | see file | Per-metric gate threshold (number) or `null` (reported only). |
| `output.keepRuns` | `EVAL_KEEP_RUNS` | `20` | Max runs to keep in `result.jsonl` (`-1` = all). |
| `output.resultsName` | `EVAL_RESULTS_NAME` | `result.jsonl` | Name of the append-only results file. |
| `output.compareFormat` | `EVAL_COMPARE_FORMAT` | `html` | `evals:compare` output: `html` (charts) or `md` (tables). |

`EVAL_GATES` is a comma list: `EVAL_GATES='recall_at_k=0.9,mrr=0.7,ndcg_at_k=null'`.

Examples:

```sh
# Override the capire version label + K
EVAL_CAPIRE_VERSION="2026.5.0" EVAL_K=10 npm run evals

# Tighten a gate for a stricter CI check
EVAL_GATES='mrr=0.8' npm run evals

# Run against an alternate golden set, keep every run
EVAL_GOLDEN_SET=data/golden-set-large.json EVAL_KEEP_RUNS=-1 npm run evals
```

> **K and the baseline are coupled.** Metrics are computed at `k`, and the baseline is
> the oldest run on file (captured at whatever `k` it ran with). Comparing a run at a
> different `k` against it produces misleading deltas — start a fresh `result.jsonl`
> (clear `runs/`) when you change `k` so the oldest run uses the new `k`.

## Outputs

Each run **appends one line** to `runs/result.jsonl` — the run's JSON report, matching
an exact contract (`run_id`, `config`, `aggregate` with
`value`/`baseline`/`delta`/`gate`/`status`, `overall_status`, `gated_failures`,
code-derived `diagnosis`, `per_question` sorted by `id`). Aggregate values are rounded
to 2 dp; per-question to 3 dp.

The **console** prints a summary (header, metrics table with trend arrows and
gate/status icons, diagnosis, result line, and the 3 weakest questions). Chart all
runs (including per-question trends) with `evals:compare`.