import { parse } from './stages/01-parse.js';
import { sectionize } from './stages/02-sectionize.js';
import { mergeSections } from './stages/03-mergeSections.js';
import { parseBlocks } from './stages/04-parse-blocks.js';
import { transformBlocks } from './stages/05-transformBlocks.js';
import { packBlocks } from './stages/06-packBlocks.js';
import { filter } from './stages/07-filter.js';
import { validate } from './stages/08-validate.js';
import { applyPatches } from './stages/00-applyPatches.js';

function flattenNodes(nodes) {
  const result = new Set();
  for (const node of nodes) {
    result.add(node.raw);
    for (const raw of flattenNodes(node.children)) result.add(raw);
  }
  return result;
}

export function runPipeline(text, config) {
  const outputParseBlocks = [];
  const outputTransformBlocks = [];
  const outputPackBlocks = [];
  const docuChunks = [];
  const emptyTransformed = [];
  const emptyBodySections = [];
  const emptyBodySectionsAfterTransformed = [];

  const outputApplyPatches = applyPatches(text); // 00 apply patches
  const outputParse = parse(outputApplyPatches, config); // 01 apply patches
  const flattenedParse = flattenNodes(outputParse)
  const outputSectionize = sectionize(outputParse, config); // 02 sectionize
  const outputMergeSections = mergeSections(outputSectionize, config); // 03 merge sections

  for (const section of outputMergeSections) {
    const trimmed = section.body.trim();

    if (trimmed.length === 0) {
      emptyBodySections.push(section);
      continue;
    }

    // --- 04 parse blocks ---
    const rawBlocks = parseBlocks(trimmed, flattenedParse);
    outputParseBlocks.push({ section, blocks: rawBlocks.map(b => ({ ...b })) });

    // --- 05 transform blocks ---
    const breadcrumb = section.headingPath.length > 1 ? section.headingPath.slice(0, -1).join(' > ') : section.headingPath.join(' > ');
    const tBreadcrumb = transformBlocks({ text: breadcrumb, type: 'heading' });
    const tHeading = transformBlocks({ text: section.heading, type: 'heading' });
    for (const block of rawBlocks) {
      block.nonTransformedText = block.text;
      block.text = transformBlocks(block, section.source);
      if (block.isEmpty) emptyTransformed.push({ section, block });
    }

    const nonEmpty = rawBlocks.filter(b => !b.isEmpty);
    if (nonEmpty.length === 0) {
      emptyBodySectionsAfterTransformed.push(section);
      continue
    };
    
    // if last block is a heading w/o body --> drop
    const last = nonEmpty[nonEmpty.length-1]
    if(last?.type === 'heading') {
      emptyTransformed.push({ section, block: last })
      nonEmpty.pop()
    }

    outputTransformBlocks.push({ section, blocks: nonEmpty });

    // --- 06 pack blocks ---
    const transformed = nonEmpty.map(b => b.text).join('\n\n'); // try if all blocks fit in one docu chunk
    const hasJava = nonEmpty.some(b => b.type === 'java-div');
    const hasNode = nonEmpty.some(b => b.type === 'node-div');

    let bodyParts;
    if (hasJava && hasNode) {
      const javaParts = packBlocks(nonEmpty.filter(b => b.type !== 'node-div'), config.maxChunkSize)
        .map(text => ({ text, label: 'java' }));
      const nodeParts = packBlocks(nonEmpty.filter(b => b.type !== 'java-div'), config.maxChunkSize)
        .map(text => ({ text, label: 'node' }));
      const seen = new Set();
      bodyParts = [...javaParts, ...nodeParts].filter(p => {
        if (seen.has(p.text)) return false;
        seen.add(p.text); return true;
      });
    } else {
      const label = hasJava ? 'java' : hasNode ? 'node' : undefined;
      const parts = (nonEmpty.length === 1 || transformed.length <= config.maxChunkSize)
        ? [transformed]
        : packBlocks(nonEmpty, config.maxChunkSize);
      bodyParts = parts.map(text => ({ text, label }));
    }
    outputPackBlocks.push({ section, bodyParts: bodyParts.map(p => p.text) });

    for (const bodyPart of bodyParts) {
      const chunk = {
        breadcrumb: tBreadcrumb,
        heading: tHeading,
        source: section.source,
        body: bodyPart.text,
        depth: section.headingPath.length,
      };
      if (bodyPart.label) chunk.label = bodyPart.label;
      docuChunks.push(chunk);
    }
  }

  if (emptyBodySections.length) process.stderr.write(`[pipeline] dropped ${emptyBodySections.length} empty body sections after merged\n`);
  if (emptyTransformed.length) process.stderr.write(`[pipeline] dropped ${emptyTransformed.length} empty blocks after transformed\n`);
  if (emptyBodySectionsAfterTransformed.length) process.stderr.write(`[pipeline] dropped ${emptyBodySectionsAfterTransformed.length} empty sections after transformed\n`);

  // --- 07 parse filter ---
  const { outputFilter, dropped: filterDropped } = filter(docuChunks, config);

  const dropped = { emptyBodySections, emptyBodySectionsAfterTransformed, filterDropped };

  return {
    sections: validate(outputFilter, config),
    dropped,
    outputApplyPatches,
    outputParse,
    outputSectionize,
    outputMergeSections,
    outputParseBlocks,
    outputTransformBlocks,
    outputPackBlocks,
    outputFilter,
  };
}
