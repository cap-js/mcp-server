/* eslint-disable no-console */
import { evaluateAndCompare } from '../lib/index.js'

evaluateAndCompare()
  .then((r) => process.exit(r.code))
  .catch((e) => {
    console.error(e)
    process.exit(3)
  })
