/* eslint-disable no-console */
// Entry point for `npm run evals:compare`: (re)build the comparison report.
//
// Optional CLI args:
//   --runs <path>    path to a result.jsonl file OR a runs dir
//   --out  <path>    output path for compare.html / compare.md
//
// Examples:
//   npm run evals:compare
//   node evals/bin/compare.js --runs runs-xenova/result.jsonl
//   node evals/bin/compare.js --runs runs-pplx/ --out runs-pplx/compare.html
import path from 'path'
import { compare } from '../lib/compare.js'

const args = process.argv.slice(2)
const get = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }
const runsArg = get('--runs')
const outArg = get('--out')

// runsArg may be a result.jsonl file or a directory — normalise to a dir.
let overrides = {}
let outPath = outArg || undefined

if (runsArg) {
  const abs = path.resolve(runsArg)
  const isJsonl = abs.endsWith('.jsonl')
  const runsDir = isJsonl ? path.dirname(abs) : abs
  const resultsName = isJsonl ? path.basename(abs) : undefined
  overrides.paths = { runsDir }
  if (resultsName) overrides.output = { resultsName }
  // default output alongside the jsonl when --out not given
  if (!outPath && isJsonl) outPath = path.join(runsDir, 'compare.html')
}

compare({ overrides, outPath })
  .then(r => process.exit(r.code))
  .catch(e => {
    console.error(e)
    process.exit(3)
  })
