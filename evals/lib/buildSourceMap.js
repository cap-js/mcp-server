import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'data', 'sourceMap.json')
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
      roots.push({ source, title: heading.title, depth: heading.depth });
    }
  }
  return roots;
}

async function build() {
  const srcPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SRC
  const text = await fs.readFile(srcPath, 'utf8')
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
