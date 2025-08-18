#!/usr/bin/env node

import run, { runTool } from './lib/run.js'

const args = process.argv.slice(2)

if (args.length > 0 && !args[0].startsWith('-')) {
  const toolName = args[0]
  const toolArgs = args.slice(1)
  runTool(toolName, ...toolArgs)
} else {
  run()
}
