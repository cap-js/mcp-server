/* eslint-disable no-console */
// Entry point for `npm run evals`: evaluate once (or sweep all subdirs when
// paths.embeddingsSweepDir is set), then build the comparison report.
//
// CDS_MCP_OFFLINE must be set before ./evaluate.js loads — it is read at module
// load by the search tool. Dynamic import keeps the assignment first.
process.env.CDS_MCP_OFFLINE = 'true'

const { evaluateAndCompare } = await import('../lib/evaluate.js')

evaluateAndCompare()
  .then(r => process.exit(r.code))
  .catch(e => {
    console.error(e)
    process.exit(3)
  })
