import { parse } from './stages/01-parse.js';
import { sectionize } from './stages/02-sectionize.js';
import { parseBlocks } from './stages/04-parse-blocks.js';
import { splitByRuntime } from './stages/06-splitByRuntime.js';
import { transformBlock, transformSection } from './stages/05-transform.js';
import { packBlocks } from './stages/07-packBlocks.js';
import { flattenNodes } from './helpers.js';
import { applyPatches } from './stages/00-applyPatches.js';

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

  for (const section of outputSectionize) {
    const trimmed = section.body.trim();

    // --- 04 parse blocks ---
    const rawBlocks = parseBlocks(trimmed, flattenedParse);
    outputParseBlocks.push({ section, blocks: structuredClone(rawBlocks) });

    // --- 05 transform blocks ---
    const breadcrumb = section.headingPath.length > 1 ? section.headingPath.slice(0, -1).join(' > ') : section.headingPath.join(' > ');
    const tBreadcrumb = transformBlock({ text: breadcrumb, type: 'heading' });
    const tHeading = transformBlock({ text: section.heading, type: 'heading' });
    const { nonEmpty, emptyBlocks, isEmptySection } = transformSection(section, rawBlocks);
    emptyTransformed.push(...emptyBlocks);
    if (isEmptySection) {
      const chunk = {
        breadcrumb: tBreadcrumb,
        heading: tHeading,
        source: `https://cap.cloud.sap${section.source}`,
        displayBody: '',
        embeddingBody: '',
        depth: section.headingPath.length,
      };
      docuChunks.push(chunk);
      continue;
    }

    outputTransformBlocks.push({ section, blocks: nonEmpty });

    // --- 06 split blocks by runtime ---
    const groups = splitByRuntime(nonEmpty, section.heading);
    
    // --- 07 pack blocks ---
    const bodyParts = groups.flatMap(({ blocks, label }) =>
      packBlocks(blocks, config).map(part => (label ? { ...part, label } : part))
    );
    outputPackBlocks.push({
      section,
      bodyParts: bodyParts.map(p => p.embeddingBody),
      storedBodies: bodyParts.map(p => p.displayBody),
    });

    for (const bodyPart of bodyParts) {
      const chunk = {
        breadcrumb: tBreadcrumb,
        heading: tHeading,
        source: `https://cap.cloud.sap${section.source}`,
        displayBody: bodyPart.displayBody,
        embeddingBody: bodyPart.embeddingBody,
        depth: section.headingPath.length,
      };
      if (bodyPart.label) chunk.label = bodyPart.label;
      docuChunks.push(chunk);
    }
  }

  if (emptyBodySections.length) process.stderr.write(`[pipeline] dropped ${emptyBodySections.length} empty body sections after merged\n`);
  if (emptyTransformed.length) process.stderr.write(`[pipeline] dropped ${emptyTransformed.length} empty blocks after transformed\n`);
  if (emptyBodySectionsAfterTransformed.length) process.stderr.write(`[pipeline] dropped ${emptyBodySectionsAfterTransformed.length} empty sections after transformed\n`);

  return {
    sections: docuChunks
  };
}
