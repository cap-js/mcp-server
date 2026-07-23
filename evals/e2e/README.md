# Level-B — End-to-end agentic eval

Measures the question stakeholders actually care about: **does an AI agent build
CAP apps better _with_ the server than without?** Task-completion benchmark,
comparing arms.

Unlike Level A (deterministic, in-repo, cents), this is stochastic and costs
real tokens. Run on demand / nightly, not per-PR.

## The arms

Each task runs in each arm, N times (default 3 — agents are stochastic, so we
report pass _rate_, not a single pass/fail):

| Arm | MCP server | capire/skills | web docs | What it isolates |
|-----|:----------:|:-------------:|:--------:|------------------|
| `none`       | ✗ | ✗ | ✗ | Base model + file access only. Floor. |
| `llms-txt`   | ✗ | ✗ | ✓ | Just a pointer to [`llms.txt`](https://cap.cloud.sap/docs/llms.txt) + web fetch — the cheapest doc access (llmstxt.org index, ~400 links). |
| `skills`     | ✗ | ✓ | ✗ | Structured guidance **without** the server — the honest competitor. |
| `mcp`        | ✓ | ✗ | ✗ | The server's standalone contribution. |
| `mcp+skills` | ✓ | ✓ | ✗ | Intended production setup. Ceiling. |

The comparisons that matter:

- `mcp` vs `none` → does the server help at all?
- `mcp` vs `llms-txt` → does local semantic search beat "just fetch the docs
  yourself"? This is the retrieval-value question: if a plain web-fetch of the
  llmstxt index does as well, the embeddings pipeline isn't earning its keep.
- `mcp+skills` vs `skills` → **does the server add value on top of skills?**
  This is the hardest, most honest bar — [capire/skills](https://github.com/capire/skills)
  already tells the agent _"Always use the CAP MCP server"_ and bakes in the
  release-note caveat, so `skills` alone is a strong baseline.

## Task suite

Tasks live in [`tasks/`](tasks/), one directory each. We deliberately **reuse
the eval convention already established in `capire/skills`** (`evals.json` +
`fixture/`) so tasks are portable between the two repos. Each task is:

```
tasks/<id>/
  task.json        # prompt + machine-checkable assertions (see schema below)
  fixture/         # optional starting project state (copied fresh per run)
  check.mjs        # optional: programmatic checker returning {id, pass}[]
```

`task.json` schema:

```jsonc
{
  "id": "add-reviews-entity",
  "prompt": "Add a Reviews entity with a managed association to Books and expose it read-only in the catalog service.",
  "stack": "node",                 // node | java | agnostic
  "fixture": "fixture",            // optional dir copied into the workspace
  "assertions": [
    // Prefer deterministic checks. `run` executes in the workspace;
    // pass = exit 0. `contains`/`absent` grep the final workspace.
    { "id": "compiles",       "type": "run",      "cmd": "cds compile srv --to csn" },
    { "id": "reviews-exists", "type": "run",      "cmd": "node check.mjs" },
    { "id": "readonly",       "type": "contains", "glob": "srv/**/*.cds", "pattern": "@readonly" },
    { "id": "no-add-sample",  "type": "absent",   "transcript": true, "pattern": "cds add sample" },
    // Only where no deterministic check is possible:
    { "id": "explains-composition-vs-association", "type": "llm-judge",
      "rubric": "Correctly distinguishes Composition (containment) from Association (reference)." }
  ]
}
```

**Discipline:** every assertion should be a machine-checkable `run` / `contains`
/ `absent` where physically possible. `llm-judge` is the fallback for genuinely
subjective criteria only — it adds cost and noise. This mirrors how
`capire/skills` writes its assertions as concrete, checkable statements.

### Seed tasks to author (mix of build + review + fix)

| id | kind | deterministic check |
|----|------|---------------------|
| `new-helpdesk-app`      | build  | `cds compile` ok; namespace present; `cuid`/`managed` used; projection not raw entity |
| `add-reviews-entity`    | build  | CSN has `Reviews` + assoc to `Books`; `@readonly` present; compiles |
| `custom-action-submit`  | build  | action in CSN; `srv.on` handler present; server boots; scripted POST returns expected |
| `validation-declarative`| review | recommends `@mandatory` + `@assert.range`; does **not** add a handler |
| `fix-broken-deploy`     | fix    | seeded broken fixture; `cds build` exits 0 after |
| `stale-api-usage`       | build  | output uses current API, **not** a deprecated one (grep deprecated tokens) |

`stale-api-usage` is the one where the server should shine most: the base
model's CAP knowledge is stale, so `none` will reach for deprecated APIs while
`mcp` retrieves the current one.

## Metrics (per arm)

- **Task success rate** — % of (task × repetition) whose assertions all pass. _Primary._
- **Token consumption** — reported as a breakdown, not one blended number
  (see [`pricing.js`](pricing.js)):
  - **input / output** split — priced ~5× apart, and the arms shift the balance
    (MCP/skills inject input context but may cut output flailing).
  - **cache** (read + write) — MCP tool results and injected skill/llms-txt
    context are prime caching candidates; a naive input count overstates cost.
  - **tool** — tokens coming from tool _results_ (e.g. `search_docs` output).
    On MCP arms this is the cost of doc chunks on every call — bloated chunks
    show up here, tying straight into the retrieval-improvement roadmap.
  - **total** and **\$/run** — under the model priced in `pricing.js`.
  - **\$/success** — total arm spend ÷ successes. **The honest efficiency
    metric**: an arm can cost more per run yet _less per outcome_. This reframes
    "MCP adds tokens" into "MCP is cheaper per solved task" (or exposes when it
    isn't). Compare `mcp` vs `llms-txt` here especially — fetching full doc
    pages over the web is token-heavy, so local retrieval should win on \$/success
    even if raw token counts look similar.
- **Deprecated-API rate** — how often output uses a deprecated API/annotation.
- **Flailing** — redundant file reads, failed tool calls, retries (proxy for
  wasted effort the server should reduce).
- **Tool usage** (mcp arms) — how often each tool was called, and whether calls
  correlated with success (attributes value to `search_docs` vs `search_model`).

> Keep the prices in [`pricing.js`](pricing.js) matched to the model you run the
> eval with, and versioned — otherwise historical \$ results drift. Token
> _counts_ stay comparable regardless of price changes.

## Harness

Two viable implementations — pick based on who's driving:

### Option 1 — Agent SDK harness (recommended; full control, in-repo)

[`run.mjs`](run.mjs) is a skeleton. It, per (task × arm × repetition):

1. Materializes a fresh workspace (temp dir; copies `fixture/` if present).
2. Spawns an agent configured for the arm:
   - `none` — no MCP, no skills.
   - `skills` — inject the capire/skills `SKILL.md` files as system context / a
     skills plugin; **no** MCP server.
   - `mcp` — start `npx -y @cap-js/mcp-server` as an MCP server for the agent.
   - `mcp+skills` — both.
3. Runs the agent to completion against `task.prompt`, capturing transcript +
   token/turn telemetry.
4. Runs the task's assertions against the final workspace + transcript.
5. Records a row: `{task, arm, rep, pass, assertions[], tokens, turns, tools[]}`.

Then aggregates into a **red/green matrix** (tasks × arms) + a cost table.

> The skeleton marks the arm-specific agent-spawn call with `TODO` — wire it to
> whatever agent runtime you standardize on (Claude Agent SDK, `claude -p`,
> opencode headless, etc.). Everything around it (workspace setup, assertion
> running, aggregation) is runtime-agnostic and already sketched.

### Option 2 — promptfoo (fastest to a shareable matrix)

[promptfoo](https://promptfoo.dev) has native MCP-server support and a built-in
red/green web UI — good for the stakeholder-facing "with vs without" story with
the least glue code. Define the 4 arms as providers, the tasks as test cases,
and the assertions as `javascript`/`python` asserts calling the same checkers.
Trade-off: less control over per-tool telemetry than Option 1.

## Running

```sh
node evals/e2e/run.mjs --arms none,skills,mcp,mcp+skills --reps 3
node evals/e2e/run.mjs --tasks add-reviews-entity --arms mcp,skills --reps 5
```

Results land in `evals/e2e/results/<timestamp>/` (matrix.json + per-run
transcripts) so you can track the improvement curve across server versions.
