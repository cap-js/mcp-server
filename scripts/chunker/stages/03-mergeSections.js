import { LEAD_IN_PATTERNS, lastMeaningfulLine } from './04-parse-blocks.js'

function bodyWithHeading(section) {
  return section.heading ? section.heading + '\n\n' + section.body : section.body;
}

function isLeadIn(section, config) {
  if (section.body.length >= config.maxChunkSize) return false;
  return LEAD_IN_PATTERNS.some(re => re.test(lastMeaningfulLine(section.body)));
}

export function mergeSections(sections, config) {
  if (sections.length === 0) return [];

  const result = [];
  let i = 0;

  while (i < sections.length) {
    const current = sections[i];
    
    // absorb all consecutive empty-body sections at same depth into the next non-empty one
    if (current.body.trim() === '') {
      let j = i + 1;
      while (j < sections.length && sections[j].depth === current.depth && sections[j].body.trim() === '') j++;
      const target = sections[j];
      if (target && target.depth === current.depth) {
        // collect all empties from result that are same depth
        let base = current;
        let accHeading = current.heading + '\n';
        // include all the intermediate empties between i+1 and j
        for (let k = i + 1; k < j; k++) {
          accHeading += sections[k].heading + '\n';
        }
        const heading = accHeading + target.heading
        result.push({ ...target, heading: heading });
        i = j + 1;
        continue;
      }
    }

    result.push(current);
    i++;
  }

  return result;
}
