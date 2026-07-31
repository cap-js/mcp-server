// Entry point for `npm run evals:compare`: (re)build the comparison report.
import { compare } from '../lib/compare.js'

compare()
  .then(r => process.exit(r.code))
  .catch(e => {
    console.error(e)
    process.exit(3)
  })
