/* eslint-disable no-console */
import { compare } from '../lib/compare/compare.js'

compare()
  .then((r) => process.exit(r.code))
  .catch((e) => {
    console.error(e)
    process.exit(3)
  })
