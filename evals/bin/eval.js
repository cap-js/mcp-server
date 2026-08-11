/* eslint-disable no-console */
// Entry point for `npm run evals`: evaluate once, then build the comparison report.
//
// This thin wrapper exists for one reason: search_docs reads CDS_MCP_OFFLINE at
// MODULE LOAD. It must be set before ./evaluate.js (which transitively imports
// the search tool) is loaded — hence the env assignment followed by a dynamic
// import. A static import here, or setting the env inside evaluate.js, would run
// too late. Offline scoring against the already-downloaded corpus keeps runs
// deterministic (no mid-run re-download).
process.env.CDS_MCP_OFFLINE = 'true'

const { evaluateAndCompare } = await import('../lib/evaluate.js')

evaluateAndCompare()
  .then(r => process.exit(r.code))
  .catch(e => {
    console.error(e)
    process.exit(3)
  })
