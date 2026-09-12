import { isHtmlStub } from './04-parse-blocks.js';

function isCutSuppressed(blocks, i) {
  const prev = blocks[i - 1];
  const next = blocks[i];

  if (next.supressCut) return true;

  // Anaphoric: next starts with anaphoric word
  if (next.isAnaphoric) return true;

  // Lead-in: prev ends with colon or lead-in phrase
  if (prev.isLeadIn) return true;

  return false;
}

export function packBlocks(blocks, maxChunkSize) {
  const chunks = [];
  let current = [];
  let currentSize = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockSize = block.text.length;

    if (current.length === 0) {
      current.push(block);
      currentSize = blockSize;
      continue;
    }

    const wouldFit = currentSize + 2 + blockSize <= maxChunkSize;

    if (wouldFit) {
      current.push(block);
      currentSize += 2 + blockSize;
    } else {
      const suppressed = isCutSuppressed(blocks, i);
      if (!suppressed) {
        chunks.push(current.map(b => b.text).join('\n\n').trim());
        current = [block];
        currentSize = blockSize;
      } else {
        // when next is suppressed — try to cut before prev instead,
        // but only if that cut point is itself not suppressed.
        if (current.length > 1 && !isCutSuppressed(blocks, i - 1)) {
          chunks.push(current.slice(0, -1).map(b => b.text).join('\n\n').trim());
          const carried = current[current.length - 1];
          current = [carried, block];
          currentSize = carried.text.length + 2 + blockSize;
        } else {
          current.push(block);
          currentSize += 2 + blockSize;
        }
      }
    }
  }

  if (current.length > 0) {
    chunks.push(current.map(b => b.text).join('\n\n').trim());
  }

  return chunks.filter(c => c.length > 0);
}
