/* eslint-disable no-console */
// Build a Source tree from docs-resources/llms-full.txt so the eval can resolve
// EVERY doc section a corpus chunk covers — not just the one on its first
// `> Source:` line. A chunk is a slice of llms-full.txt spanning several
// headings; deeper headings carry their own `> Source:` line, but a chunk
// boundary can split a heading from its Source line. The tree recovers those.
//
// Output (evals/data/source-tree.json):
//   {
//     source: "<abs path to llms-full.txt>",
//     tree:       { "<page-path>": ["<anchor-url>", ...] },   // page → its anchors
//     byHeadingInPage: { "<page-path>": { "<heading-lc>": "<source-url>" } },
//     byBreadcrumb: { "<a > b > c lc>": "<source-url>" },  // full heading path → url
//     byLeaf:       { "<heading-lc>": "<source-url>" }      // leaf heading → url
//   }
//
// byBreadcrumb / byLeaf let the eval score the live LLM-summary corpus, whose
// chunks are keyed by a breadcrumb ("The Bookshop Sample > Databases") instead of
// a `> Source:` URL. Regenerate with `npm run evals:build-source-tree`. Do not hand-edit.
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'data', 'source-tree.json')

// Default location of the docs export; override with argv[2].
const DEFAULT_SRC = '/Users/i543501/SAPDevelop/docs-resources/llms-full.txt'

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/
const SOURCE = /^>\s*Source:\s*(\S+)/

// Strip a trailing VitePress heading attribute like `{.subtitle}`.
function cleanHeading(t) {
  return t.replace(/\s*\{[^}]*\}\s*$/, '').trim()
}

export function buildSourceTree(text) {
  const tree = {}
  const byHeadingInPage = {}
  const byBreadcrumb = {} // full heading path ("A > B > C") → url
  const byLeaf = {} // leaf heading ("C") → url (first occurrence wins)
  const stack = [] // [{ level, text }] heading ancestry
  let lastHeading = null // leaf text of the most recent heading
  let lastCrumb = null // full path of the most recent heading
  for (const line of text.split('\n')) {
    const h = HEADING.exec(line)
    if (h) {
      const level = h[1].length
      const txt = cleanHeading(h[2])
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, text: txt })
      lastHeading = txt
      lastCrumb = stack.map(s => s.text).join(' > ')
      continue
    }
    const s = SOURCE.exec(line)
    if (s) {
      const url = s[1]
      const page = url.split('#')[0]
      const anchors = (tree[page] ||= [])
      if (url.includes('#') && !anchors.includes(url)) anchors.push(url)
      if (lastHeading !== null) {
        const map = (byHeadingInPage[page] ||= {})
        // Page-scoped, so cross-page heading collisions can't occur; a heading
        // repeated on ONE page keeps the first occurrence (the un-suffixed anchor).
        const key = lastHeading.toLowerCase()
        if (!(key in map)) map[key] = url
        const crumbKey = lastCrumb.toLowerCase()
        if (!(crumbKey in byBreadcrumb)) byBreadcrumb[crumbKey] = url
        if (!(key in byLeaf)) byLeaf[key] = url
      }
      lastHeading = null
      lastCrumb = null
    }
  }
  return { tree, byHeadingInPage, byBreadcrumb, byLeaf }
}

async function main() {
  const srcPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SRC
  const text = await fs.readFile(srcPath, 'utf8')
  const { tree, byHeadingInPage, byBreadcrumb, byLeaf } = buildSourceTree(text)
  const pages = Object.keys(tree).length
  const anchors = Object.values(tree).reduce((n, a) => n + a.length, 0)
  await fs.writeFile(
    OUT,
    JSON.stringify({ source: srcPath, tree, byHeadingInPage, byBreadcrumb, byLeaf }, null, 2)
  )
  console.log(
    `Wrote ${path.relative(process.cwd(), OUT)} — ${pages} pages, ${anchors} anchors, ` +
      `${Object.keys(byBreadcrumb).length} breadcrumbs`
  )
}

// Run as a script; importable for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(e)
    process.exit(1)
  })
}
