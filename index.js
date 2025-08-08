#!/usr/bin/env node

import run from './lib/index.js'

const args = process.argv.slice(2)
const options = {}

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg.startsWith('--')) {
    const toolName = arg.slice(2)
    const toolArgs = []
    i++
    while (i < args.length && !args[i].startsWith('--')) {
      toolArgs.push(args[i])
      i++
    }
    i--
    options.tools = toolName
    options.args = toolArgs
    break
  }
}

run(options)
