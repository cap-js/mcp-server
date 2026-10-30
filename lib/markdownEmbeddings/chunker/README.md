# Markdown chunker stage harness

`chunkMarkdown(text, config)` is synchronous. Algorithm defaults live in the
numbered stage files; `pipelineStages.js` groups their order and adapts their
inputs/outputs. `stageHarness.js` compiles optional adapter extensions once per
invocation. `runPipeline` remains an alias.

## Execution order

| Stage ID | Execution group | Context output |
| --- | --- | --- |
| `parseMarkdown` | documentStart | `nodes` |
| `buildSections` | documentStart | `sections`, `flattenedParse` |
| `mergeSections` | documentStart | `sections` |
| `parseBlocks` | section | `blocks` |
| `transformBlocks` | section | `blocks`, `heading`, `breadcrumb` |
| `partitionBlocks` | section | `partitions` |
| `packBlocks` | partition | `fragments` |
| `filterChunks` | documentEnd | `chunks`, `dropped.filterDropped` |

The first three stages run once. Section stages run for each section, followed
by partition stages for each resulting partition. The runner assembles chunks
from the fragments, then runs the documentEnd group once. Final validation is
an explicit call in `chunkMarkdown.js`, outside the registry. This retains
section-by-section execution rather than running each stage across the whole
document.

## Add logic to a stage

```js
const adapter = {
  wrap: {
    transformBlocks: (next) => (context) => {
      // Before the default stage.
      next(context)
      // After the default stage.
      context.metadata.category = 'reference'
    }
  }
}
```

Wrapper factories are called once per invocation, not per section. `next` runs
the existing stage on the same context. Wrappers can replace an algorithm when
needed; final validation cannot be replaced or wrapped.

## Insert a stage

```js
const adapter = {
  insert: [
    {
      id: 'normalizeDocument',
      before: 'parseMarkdown',
      run(document) {
        document.text = document.text.replace(/\r\n/g, '\n')
      }
    },
    {
      id: 'annotateBlocks',
      after: 'parseBlocks',
      run(context) {
        context.metadata.blockCount = context.blocks.length
      }
    }
  ]
}
```

Use stable stage IDs as anchors, not filename numbers. Each insertion specifies
exactly one `before` or `after` and inherits its anchor's execution group.
No `scope` or `phase` property is needed. Insertions are applied to arrays in
registration order and may anchor to previously registered insertions, but
not forward references. At the same anchor and side, registration order is
preserved. There is no insertion tree: each registration splices a stage into
the current array.

Scope changes require an explicit runner boundary: a document-wide insertion
cannot be placed between two section stages. A document insertion after
`mergeSections` runs before section processing; one before `filterChunks` runs
after every section has been packed. Insert after `filterChunks` to process
filtered output. Validation then runs last; `validateChunks` is not an anchor
or a wrappable stage.

## Context ownership

- Document context: `text`, effective `config`, `metadata`, `nodes`, `sections`,
  `chunks`, diagnostics and existing debug outputs.
- Section context: `document`, effective `config`, `section`, `metadata`,
  `blocks`, `partitions`, rendered `heading`/`breadcrumb`, optional `source`.
- Partition context: `document`, `sectionContext`, effective `config`, `blocks`,
  `metadata`, optional `label`, `fragments`.

Contexts are invocation-owned mutable working state. Do not mutate caller
configuration or adapter registrations. Document metadata comes from
`config.metadata`; section, partition and fragment `metadata` override it in
that order. Metadata must be structured-cloneable. Each output chunk receives
its own metadata copy. The embedding writer forwards these attributes together
with standard source/heading metadata. Custom attributes belong in `metadata`;
arbitrary properties on a partition are not copied to output chunks. Metadata
copies at section, partition and output boundaries isolate sibling mutations.

Section/partition stages may set `context.skip = true` to omit the current
section/partition. Document stages always run, including final validation.
Do not retain contexts or mutate them asynchronously.

## Nested extensions

Keep nested syntax hooks such as `parseExtensionBlock` for parser recursion;
stage wrappers operate at section granularity. `parseOptions` still configures
parsing. Use `insert` for document preprocessing and `wrap` for transformation,
partitioning, source mapping and filtering; the former replacement hooks are
removed. For example, a transform wrapper can set `context.transformOptions`
before `next(context)` and `context.source` afterwards. A filter wrapper can
set `document.filterPolicy` before delegating.
CAPire uses `insert` for patches and `wrap` for runtime transformation,
partitioning, source mapping and filtering, with its nested div parser hook.

Errors identify the stage and section and retain the original error as `cause`.
Invalid IDs, unknown anchors and unknown wrapper targets are rejected before
processing. Promise returns are checked at execution time, both on the stage
and its wrapper, so a wrapper discarding `next()`'s return cannot hide a promise.

Existing debug outputs are retained by default. Set `debug: false` to omit
block snapshots and packing diagnostics without changing the returned chunks.
