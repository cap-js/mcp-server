#!/usr/bin/env node
// Executable entry point for the CAP MCP retrieval eval.
// All behaviour is configured via evals/config.json + EVAL_* env vars.
import { run } from './lib/cli.js'

run()
  .then(({ code }) => process.exit(code))
  .catch(err => {
    console.error(err)
    process.exit(3)
  })
