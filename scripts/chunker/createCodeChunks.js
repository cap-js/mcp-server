import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from './config.js';
import { runPipeline } from './pipeline.js';
import { readInput, storeText, parseArgs } from '../createEmbeddings.js'

async function main() {
  const { overrides, input } = parseArgs(process.argv.slice(2));
  const config = mergeConfig(overrides);

  const text = await readInput(input || config.input);
  const { sections } = runPipeline(text, config);
  const serialized = sections.map(storeText);
  const payload = JSON.stringify({ count: serialized.length, chunks: serialized }, null, 2);

  if (config.output) {
    await writeFile(config.output, payload)
  } else {
    process.stdout.write(payload + '\n');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}
