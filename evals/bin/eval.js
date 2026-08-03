/* eslint-disable no-console */
// Entry point for `npm run evals`: run the eval config.runs times, then compare.
//
// search_docs reads CDS_MCP_OFFLINE at module-load, so set it BEFORE the dynamic
// import below — offline scoring against the downloaded corpus keeps runs
// deterministic (no mid-run re-download).
process.env.CDS_MCP_OFFLINE = 'true'

const { runAll } = await import('../lib/cli.js')

runAll()
  .then(r => process.exit(r.code))
  .catch(e => {
    console.error(e)
    process.exit(3)
  })
