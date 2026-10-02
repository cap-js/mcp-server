export function mergeSections(sections) {
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
