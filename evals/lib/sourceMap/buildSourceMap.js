import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { transformBlocks } from './transformBlocks.js'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', '..','data', 'sourceMap.json')
// Default location of the docs export; override with argv[2].
const DEFAULT_SRC = 'llms-full.txt'

function isHeadingLine(lines, index) {
  const match = /^(\s*#{1,6}) (.+)$/.exec(lines[index]);
  if (!match) return null;
  const window = lines.slice(index + 1, index + 4);
  const offset = window.findIndex(l => /^>\s*Source:\s/.test(l));
  if (offset === -1) return null;
  return { depth: match[1].length, title: match[2], source: window[offset] };
}

function buildSourceMap(text, config) {
  const lines = text.split('\n');
  const roots = []

  for (let i = 0; i < lines.length; i++) {
    const heading = isHeadingLine(lines, i);
    if (heading) {
      const source = heading.source.split('> Source: ')?.[1]
      const title = transformBlocks({ text: heading.title, type: 'heading' })
      roots.push({ source, title, nonTransformedTitle: heading.title, depth: heading.depth });
    }
  }
  const getBreadCrumb = (key, outputKey) => {
    for (let i = 0; i < roots.length; i++) {
      const path = [roots[i][key]]
      let currDepth = roots[i].depth
      for (let j = i - 1; j >= 0; j--) {
        if (roots[j].depth < currDepth) {
          path.unshift(roots[j][key])
          currDepth = roots[j].depth
        }
        if (roots[j].depth <= 1) break
      }
      roots[i][outputKey] = path.join(' > ')
    }
  }
  getBreadCrumb('title', 'breadcrumb')
  getBreadCrumb('nonTransformedTitle', 'nonTransformedBreadcrumb')
  return roots;
}

async function build() {
  const srcPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SRC
  let text
  try {
    text = await fs.readFile(srcPath, 'utf8')
  } catch (e) {
    const response = await fetch('https://cap.cloud.sap/docs/llms-full.txt');
    if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
    text = await response.text();
  }
  const sourceMap = buildSourceMap(text)
  await fs.writeFile(
    OUT,
    JSON.stringify(sourceMap, null, 2)
  )
}

build()
  .catch(e => {
    console.error(e)
    process.exit(3)
  })
