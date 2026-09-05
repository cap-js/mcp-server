# Chunker

Converts a VitePress/markdown documentation file into size-bounded, embedding-ready chunks as a JSON array.

Designed for `llms-full.txt` from the CAP documentation but works with any similarly structured markdown.

---

## Pipeline

| # | File | Function | What it does |
|---|------|----------|-------------|
| 00 | `stages/00-applyPatches.js` | `applyPatches` | Fix known source bugs (unclosed containers, fence mismatches) |
| 01 | `stages/01-parse.js` | `parse` | Build heading tree; only headings with `> Source:` annotations are recognized |
| 02 | `stages/02-sectionize.js` | `sectionize` | DFS-flatten tree to ordered sections; fold headings deeper than `maxHeadingDepth` |
| 03 | `stages/03-mergeSections.js` | `mergeSections` | Absorb empty sections; optionally prepend lead-in sections to children |
| 04 | `stages/04-parse-blocks.js` | `parseBlocks` | Parse body into 13 typed blocks (fences, containers, divs, tables, lists, paragraphs…) |
| 05 | `stages/05-transformBlocks.js` | `transformBlocks` | Clean blocks for embedding: strip markup, resolve links, decode entities, label Java/Node divs |
| 06 | `stages/06-packBlocks.js` | `packBlocks` | Greedy block packer respecting `maxChunkSize`; suppresses cuts at anaphoric/lead-in boundaries |
| 07 | `stages/07-filter.js` | `filter` | Drop release-notes, empty, duplicate, redirect-stub, and low-value chunks |
| 08 | `stages/08-validate.js` | `validate` | Assert every chunk has required fields; warn on size outliers |

Stage 06 runs twice for sections containing both `java-div` and `node-div` blocks (once per language), then deduplicates.

---

## CLI

```sh
node scripts/chunker/index.js [input] [options]
```

| Argument / Flag | Default | Description |
|----------------|---------|-------------|
| `input` (positional) | fetches live CAP docs URL | Path to input `.txt` file |
| `--output PATH` | `public/embeddings/code-chunks.json` | Output file; omit to write to stdout |
| `--max-chunk-size N` | `1536` | Max characters per chunk body (~512 tokens) |
| `--min-chunk-size N` | `50` | Chunks shorter than this are dropped unless they contain code/table/link |
| `--max-heading-depth N` | `4` | Headings deeper than this are folded into the parent section |

**Examples:**

```sh
# Default run (reads llms-full.txt, writes to public/embeddings/code-chunks.json)
node scripts/chunker/index.js

# Custom input/output
node scripts/chunker/index.js path/to/llms-full.txt --output chunks.json

# Tune chunk size (unit is characters; 1536 ≈ 512 tokens at ~3 chars/token)
node scripts/chunker/index.js --max-chunk-size 1536 --min-chunk-size 50 --output chunks.json input.txt
```

---

## Programmatic API

```js
import { runPipeline } from './scripts/chunker/pipeline.js';
import { mergeConfig }  from './scripts/chunker/config.js';

const config = mergeConfig({ maxChunkSize: 512 });
const { chunks, dropped } = runPipeline(text, config);
```

`runPipeline` returns `{ chunks, dropped, ...debugStages }`.  
`mergeConfig(overrides)` merges against `DEFAULT_CONFIG` and coerces numeric strings.

Additional programmatic-only config:

| Option | Default | Description |
|--------|---------|-------------|
| `debug` | `true` | Include intermediate stage outputs in the return value |

---

## Input format

A single UTF-8 markdown file. Every heading that should become a section boundary must be followed within 3 lines by a source annotation:

```markdown
## Heading Title
> Source: /docs/path#anchor
```

Headings without this annotation are ignored by the parser.

---

## Output format

JSON written to a file or stdout:

```json
{
  "count": 1234,
  "chunks": [
    "Introduction > Getting Started\n\n## Getting Started\n\n> Source: /docs/get-started\n\nBody text…",
    ...
  ]
}
```

Each chunk string layout:

```
<breadcrumb>   — ancestor titles joined with " > " (current heading omitted)

<heading>      — raw markdown heading, e.g. "## Getting Started"

<source>       — "> Source: /docs/path#anchor"  (omitted if blank)

<body>         — cleaned, transformed body text
```

Progress and drop-count diagnostics are written to **stderr**, not stdout.

---

## Tests

```sh
npm test
```

Requires Node 24+. Tests live in `__tests__/` with one file per stage plus an end-to-end integration test in `pipeline.test.js`.
