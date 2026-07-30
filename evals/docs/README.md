# CAP MCP RAG — Deterministic Retrieval Evals

A **pure-code, fully deterministic** evaluation harness for the CAP MCP server's
`search_docs` retrieval. It scores the real retrieval path against a **frozen golden
set** with human-authored relevance labels, computes standard IR metrics by pure
arithmetic, compares against a stored baseline, applies gate thresholds, and emits a
machine-readable JSON report plus a human console summary. **No LLM is used anywhere.**

See [`METRICS.md`](./METRICS.md) for metric definitions, the stable-identifier scheme,
and the determinism guarantees.

## Folder structure

```
evals/
  config.json          # single source of all config (committed) — see "Configuration"
  lib/                 # implementation (invoked via npm scripts; no wrapper entry files)
    config.js          #   config loader (config.json + EVAL_* env overrides)
    cli.js             #   run(): orchestration — load → preflight → retrieve → score → append
    show.js            #   show(): re-render a stored run to the console
    compare.js         #   compare(): chart every run's metrics into an HTML dashboard
    store.js           #   result.jsonl read/append (cap to keepRuns) + baseline promote
    runner.js          #   pure core: buildReport, diagnose, worstQuestions, console render
    metrics.js         #   pure metric math (Recall@K, Precision@K, MRR, Hit-Rate@K, nDCG@K)
    ids.js             #   stable content-derived doc ids  (<label>#<sha1(text)[:8]>)
    retriever.js       #   index loader + default retriever (real search_docs path); pluggable
  data/                # committed inputs
    golden-set.json    #   frozen { id, question, relevant_doc_ids }; relevance authored once
    baseline.json      #   promoted prior run — deltas, diagnosis, weakest-questions
  docs/
    README.md          #   this file
    METRICS.md         #   metric definitions + stable-ID scheme + determinism
  runs/                # transient run output (git-ignored except .gitkeep)
    result.jsonl       #   one JSON run report per line; capped to keepRuns (newest kept)
    compare.html       #   metric-trend dashboard (or compare.md if compareFormat=md)
  tests/
    unit/              # unit tests
      metrics.test.js  runner.test.js  config.test.js  ids.test.js  cli.test.js  compare.test.js
```

## Run

From the repo root (`@cap-js/mcp-server`):

```sh
npm run evals            # run the eval (reads config.json; offline) → appends to result.jsonl
npm run evals:show       # re-print the newest run's console summary
npm run evals:show -- <run_id>   # print a specific run from result.jsonl
npm run evals:compare    # chart every run's metrics → runs/compare.html
npm run evals:test       # unit + determinism + config tests
npm run evals:baseline   # promote the newest run in result.jsonl -> data/baseline.json
```

Each run appends one line (its JSON report) to **`runs/result.jsonl`**, which is capped
to the most recent `output.keepRuns` runs. The terminal shows the summary + the 3
weakest questions; `evals:show` re-prints any run, and `evals:compare` charts all of
them. There is no per-run folder and no markdown report.

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

The runner **requires the offline cache** (`embeddings/code-chunks.*` and the ONNX model
under `models/`). If it's missing, run any `search_docs` query once online first to
populate it, then run offline.

## Configuration

All behaviour is driven by [`config.json`](../config.json); every value is overridable
by an `EVAL_*` environment variable (env wins over file), and both are overridable
programmatically via `run({ overrides })` in `lib/cli.js` (overrides win last).

`config.json` holds only the settings a project actually tunes:

| config.json key | Env override | Meaning |
|---|---|---|
| `k` | `EVAL_K` | Cutoff K for all @K metrics. |
| `offline` | `CDS_MCP_OFFLINE` | Force the default retriever offline (deterministic). |
| `capire_version` | `EVAL_CAPIRE_VERSION` | capire docs version, recorded in the report `config` + console header (provenance only). |
| `gates.<metric>` | `EVAL_GATES` | Per-metric gate threshold (number) or `null` (reported only). |

The following default in code and are omitted from `config.json`; set them via env
(or add them to `config.json`) only when you need to override a default:

| Setting | Env override | Default | Meaning |
|---|---|---|---|
| golden set path | `EVAL_GOLDEN_SET` | `data/golden-set.json` | Path to the golden set (relative to `evals/`, or absolute). |
| baseline path | `EVAL_BASELINE` | `data/baseline.json` | Path to the baseline report. |
| runs dir | `EVAL_RUNS_DIR` | `runs` | Directory for run output. |
| keep runs | `EVAL_KEEP_RUNS` | `20` | Max runs to keep in `result.jsonl` (`-1` = all). |
| results name | `EVAL_RESULTS_NAME` | `result.jsonl` | Name of the append-only results file. |
| compare format | `EVAL_COMPARE_FORMAT` | `html` | `evals:compare` output: `html` (charts) or `md` (tables). |

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

> **K and the baseline are coupled.** Metrics are computed at `k`, and the baseline was
> captured at a specific `k`. Comparing a run at a different `k` against that baseline
> produces misleading deltas — re-capture a baseline (`npm run evals:baseline`) whenever
> you change `k`.

## Outputs

Each run **appends one line** to `runs/result.jsonl` — the run's JSON report, matching
an exact contract (`run_id`, `config`, `aggregate` with
`value`/`baseline`/`delta`/`gate`/`status`, `overall_status`, `gated_failures`,
code-derived `diagnosis`, `per_question` sorted by `id`). Aggregate values are rounded
to 2 dp; per-question to 3 dp.

The **console** prints a summary (header, metrics table with trend arrows and
gate/status icons, diagnosis, result line, and the 3 weakest questions). Re-print any
run with `evals:show`, or chart all runs (including per-question sparklines) with
`evals:compare`.

## Run-output hygiene (no pollution over many runs)

- All output lives under `runs/`, which is **git-ignored** except `.gitkeep`.
- `result.jsonl` is one append-only file — one line per run, no per-run folders.
- It is capped to the most recent `output.keepRuns` runs (default 20); `-1` keeps all.
- Nothing is written outside `runs/`; the golden set and baseline in `data/` are never
  mutated by a run (promoting a baseline is an explicit `npm run evals:baseline`).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All gated metrics within threshold (`overall_status: pass`). |
| `1` | A gated metric is below its threshold (`overall_status: fail`) — CI should block the merge. |
| `2` | Pre-flight failed: a `relevant_doc_id` is missing from the current index (stale label). |
| `3` | Unexpected error (e.g. golden set missing/malformed). |

## Determinism

- No LLM, no randomness, no wall-clock **in scoring**. `run_id` (an ISO timestamp + a
  short suffix) is the **only** nondeterministic field, and it is stamped after
  computation — it never affects a metric.
- Same golden set + same retriever output → **byte-identical** report body (except
  `run_id`) and byte-identical console body. Asserted by `tests/unit/runner.test.js`.

## Gates & baseline

`config.json` gate thresholds are **derived empirically from a baseline run**, not
hardcoded standards. To (re)establish a baseline:

1. Run the eval on a known-good commit: `npm run evals`.
2. Promote that run to the baseline: `npm run evals:baseline`
   (writes the newest run in `runs/result.jsonl` → `data/baseline.json`).
3. Set each gated threshold in `config.json` at or just below the baseline value
   (leaving a small tolerance for noise). Reported-only metrics stay `null`.

Only `recall_at_k`, `mrr`, and `hit_rate_at_k` are gated by default. `precision_at_k`
and `ndcg_at_k` are reported (`gate: null`) and never fail the run.

## Refreshing the golden set after a corpus re-index

Stable ids are derived from chunk **text** (`lib/ids.js`). If a re-index changes a
labelled chunk's text, its id changes and the **pre-flight check aborts** (exit `2`)
listing the stale ids — it never silently scores against dead labels. To refresh:

1. Re-populate the offline cache with the new index (run a `search_docs` query online).
2. For each stale id reported by the pre-flight check, find the current chunk that now
   covers the same topic and update `relevant_doc_ids` in `data/golden-set.json`.
   Relevance is a **human judgment** made once — re-confirm it, don't auto-map.
3. Re-run `npm run evals`; when green, re-promote a baseline (above) if the index change
   is intentional and the new numbers are the new reference.

## Adding questions

Append `{ id, question, relevant_doc_ids }` to `data/golden-set.json` (keep `id`s
ascending; they sort deterministically). `relevant_doc_ids` must be stable ids present
in the current index — the pre-flight check enforces this on the next run. To discover
ids for a question, retrieve for it and inspect the top results' ids via
`lib/retriever.js` (`makeDefaultRetriever` returns ranked ids; `loadIndex().byId` maps
id → text).
