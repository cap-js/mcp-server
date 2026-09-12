// Pre-patches for known bugs in llms-full.txt source content.
// Applied to the raw document text before parsing.
// Each find string must be unique in the document — enforced at runtime.
// Delete an entry when the upstream doc is fixed.
export const PATCHES = [
  {
    // Bug 1: unclosed ::: code-group — closer missing after yaml fence
    find: '```\n\nThe following options are available:',
    replace: '```\n:::\n\nThe following options are available:',
  },
  {
    // Bug 5: :::: closer should be ::: — count mismatch in details block
    find: 'whole purpose of that project is to be a _sample_.\n::::',
    replace: 'whole purpose of that project is to be a _sample_.\n:::',
  },
  {
    // Bug 4: unclosed ::: code-group — closer missing after csv fence
    find: '```\n\n[Learn more about Enabling Draft',
    replace: '```\n:::\n\n[Learn more about Enabling Draft',
  },
  {
    // Bug 24: :::: closer should be ::: in ::: warning block
    find: "don't use element names as aliases.\n::::",
    replace: "don't use element names as aliases.\n:::",
  },
  {
    // Bug 25: :::: closer should be ::: in ::: tip block
    find: "prefer other simpler functions like `contains`.\n::::",
    replace: "prefer other simpler functions like `contains`.\n:::",
  },
  {
    // Bug 26: :::: closer should be ::: in ::: code-group block
    find: "HttpClientAccessor.getHttpClient(destination);\n...\n```\n::::",
    replace: "HttpClientAccessor.getHttpClient(destination);\n...\n```\n:::",
  },
  {
    // Bug 21: ::: code-group has stray ``` closer with no opener — remove it
    find: 'entity Zoo : animal.Zoo {}     //> : foo.bar.scoped.nested.Zoo\n```\n\n:::',
    replace: 'entity Zoo : animal.Zoo {}     //> : foo.bar.scoped.nested.Zoo\n\n:::',
  },
  {
    // Bug 23: ::: danger missing closer before next heading
    find: 'The CI does that in production.',
    replace: 'The CI does that in production.\n:::',
  },
  {
    // Bug 33: orphan ::: closer with no opener — remove it
    find: '   }`\n   ```\n:::\n\nThe graphic below',
    replace: '   }`\n   ```\n\nThe graphic below',
  },
  {
    // Bug: malformed {}.learn-more} instead of {.learn-more} on signature cache link
    find: '[Learn more about signature cache and its configuration.](https://www.npmjs.com/package/@sap/xssec#signature-cache){}.learn-more}',
    replace: '[Learn more about signature cache and its configuration.](https://www.npmjs.com/package/@sap/xssec#signature-cache){.learn-more}',
  },
  {
    find: '[Learn more about migration to SAP´s `spring-security` library.](https://github.com/SAP/cloud-security-services-integration-library/blob/main/spring-security/Migration_SpringXsuaaProjects.md)',
    replace: '[Learn more about migration to SAP´s `spring-security` library.](https://github.com/SAP/cloud-security-services-integration-library/blob/main/spring-security/Migration_SpringXsuaaProjects.md){.learn-more}',
  },
  {
    // Bug: missing closing ``` in ::: code-group fence for cds-plugin.js
    find: "cds.add?.register?.('postgres', class extends cds.add.Plugin {})\n:::",
    replace: "cds.add?.register?.('postgres', class extends cds.add.Plugin {})\n```\n:::",
  },
  {
    // Bug 3: malformed link — URL is a reference-style label `[annotation expression](#null-value)`
    find: '* `$Null()` representing the `null` value [`Null`]([annotation expression](#null-value)).',
    replace: '* `$Null()` representing the `null` value ([annotation expression](#null-value)).',
  },
];

export function applyPatches(text) {
  for (const patch of PATCHES) {
    const count = text.split(patch.find).length - 1;
    if (count === 0) {
      process.stderr.write(`[patches] warning: find string not found — patch may be stale: ${JSON.stringify(patch.find.slice(0, 60))}\n`);
      continue;
    }
    if (count > 1) {
      throw new Error(`[patches] find string matches ${count} times — patch is ambiguous: ${JSON.stringify(patch.find.slice(0, 60))}`);
    }
    text = text.replace(patch.find, patch.replace);
  }
  return text;
}
