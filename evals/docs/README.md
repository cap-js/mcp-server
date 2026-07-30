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
  run.js               # executable entry point
  lib/                 # implementation
    config.js          #   config loader (config.json + EVAL_* env overrides)
    cli.js             #   orchestration: load → preflight → retrieve → score → persist
    runner.js          #   pure core: buildReport, diagnose, worstQuestions, console render
    metrics.js         #   pure metric math (Recall@K, Precision@K, MRR, Hit-Rate@K, nDCG@K)
    ids.js             #   stable content-derived doc ids  (<label>#<sha1(text)[:8]>)
    retriever.js       #   index loader + default retriever (real search_docs path); pluggable
  data/                # committed inputs
    golden-set.json    #   frozen { id, question, relevant_doc_ids }; relevance authored once
    baseline.json      #   promoted prior run — deltas, diagnosis, worst-questions
  docs/
    README.md          #   this file
    METRICS.md         #   metric definitions + stable-ID scheme + determinism
  runs/                # transient run output (git-ignored except .gitkeep)
    latest.json        #   the most recent run (always overwritten)
    eval-run-<id>.json #   timestamped copies, pruned to output.keepRuns
  tests/
    unit/              # unit tests
      metrics.test.js  #   pure metric math
      runner.test.js   #   buildReport / diagnose / worstQuestions / determinism
      config.test.js   #   config loader: env overrides, gate parsing, validation
```

## Run

From the repo root (`@cap-js/mcp-server`):

```sh
npm run evals            # node evals/run.js  (offline + all knobs from config.json)
npm run evals:test       # unit + determinism + config tests
npm run evals:baseline   # promote evals/runs/latest.json -> evals/data/baseline.json
```

The runner **requires the offline cache** (`embeddings/code-chunks.*` and the ONNX model
under `models/`). If it's missing, run any `search_docs` query once online first to
populate it, then run offline.

## Configuration

All behaviour is driven by [`config.json`](../config.json); every value is overridable
by an `EVAL_*` environment variable (env wins over file), and both are overridable
programmatically via `run({ overrides })` in `lib/cli.js` (overrides win last).

| config.json key | Env override | Meaning |
|---|---|---|
| `k` | `EVAL_K` | Cutoff K for all @K metrics. |
| `offline` | `CDS_MCP_OFFLINE` | Force the default retriever offline (deterministic). |
| `paths.goldenSet` | `EVAL_GOLDEN_SET` | Path to the golden set (relative to `evals/`, or absolute). |
| `paths.baseline` | `EVAL_BASELINE` | Path to the baseline report. |
| `paths.runsDir` | `EVAL_RUNS_DIR` | Directory for run output. |
| `corpus.corpus_version` | `EVAL_CORPUS_VERSION` | Free-form label recorded in the report `config`. |
| `corpus.index_rev` | `EVAL_INDEX_REV` | Index revision recorded in the report `config`. |
| `corpus.embedding_model` | `EVAL_EMBEDDING_MODEL` | Embedding-model label recorded in the report `config`. |
| `gates.<metric>` | `EVAL_GATES` | Per-metric gate threshold (number) or `null` (reported only). |
| `output.writeTimestamped` | `EVAL_WRITE_TIMESTAMPED` | Also write `eval-run-<id>.json` (else only `latest.json`). |
| `output.keepRuns` | `EVAL_KEEP_RUNS` | Max timestamped runs to keep (`0` = none, `-1` = all). |
| `output.latestName` | `EVAL_LATEST_NAME` | Filename of the always-current pointer. |

`EVAL_GATES` is a comma list: `EVAL_GATES='recall_at_k=0.9,mrr=0.7,ndcg_at_k=null'`.

Examples:

```sh
# Different corpus metadata + K
EVAL_CORPUS_VERSION="capire@2026-07-28" EVAL_INDEX_REV=4471 EVAL_K=10 npm run evals

# Tighten a gate for a stricter CI check
EVAL_GATES='mrr=0.8' npm run evals

# Run against an alternate golden set, keep every run, write only latest.json
EVAL_GOLDEN_SET=data/golden-set-large.json EVAL_KEEP_RUNS=-1 npm run evals
```

> **K and the baseline are coupled.** Metrics are computed at `k`, and the baseline was
> captured at a specific `k`. Comparing a run at a different `k` against that baseline
> produces misleading deltas — re-capture a baseline (`npm run evals:baseline`) whenever
> you change `k`.

## Outputs

Both are written on every run:

1. **JSON** — `runs/latest.json` (always) and, when `output.writeTimestamped`,
   `runs/eval-run-<run_id>.json`. Matches an exact contract (`config`, `aggregate` with
   `value`/`baseline`/`delta`/`gate`/`status`, `overall_status`, `gated_failures`, a
   code-derived `diagnosis`, and `per_question` sorted by `id`). Aggregate values are
   rounded to 2 dp; per-question metrics to 3 dp.
2. **Console** — a human summary on stdout (header box, metrics table with trend arrows
   and gate/status icons, diagnosis, result line, worst-questions).

## Run-output hygiene (no pollution over many runs)

- All output lives under `runs/`, which is **git-ignored** except `.gitkeep`.
- `latest.json` is overwritten each run — a stable path for tooling.
- Timestamped copies are pruned to `output.keepRuns` (default 20), newest kept.
- Set `EVAL_WRITE_TIMESTAMPED=false` to keep only `latest.json`, or `EVAL_KEEP_RUNS=0`
  to write a timestamped file then immediately prune all but `latest.json`.
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
   (copies `runs/latest.json` → `data/baseline.json`).
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
