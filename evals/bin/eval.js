// Entry point for `npm run evals`: run the eval config.runs times, then compare.
import { runAll } from '../lib/cli.js'

runAll()
  .then(r => process.exit(r.code))
  .catch(e => {
    console.error(e)
    process.exit(3)
  })
