/* eslint-disable no-console */
// Entry point for `npm run evals`: run the eval config.runs times, then compare.
//
// Score offline: search_docs reads CDS_MCP_OFFLINE at module-load time to decide
// whether to (re)download embeddings, so it MUST be set before any eval module
// (which transitively imports lib/tools.js → searchMarkdownDocs) is imported.
// Scoring against the already-downloaded corpus is what keeps runs deterministic.
process.env.CDS_MCP_OFFLINE = 'true'

const { runAll } = await import('../lib/cli.js')

runAll()
  .then(r => process.exit(r.code))
  .catch(e => {
    console.error(e)
    process.exit(3)
  })
