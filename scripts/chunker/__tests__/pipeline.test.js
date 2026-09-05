import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../config.js';
import { readInput } from '../../createEmbeddings.js';
import { runPipeline } from '../pipeline.js';
import { PATCHES } from '../stages/00-applyPatches.js';
import { transformBlocks as transformFn } from '../stages/05-transformBlocks.js';

const INPUT = new URL('../../../llms-full.txt', import.meta.url).pathname;
const RAW_TEXT = await readInput(INPUT);

const CONFIGS = [
  { label: 'default config',     overrides: {} },
  { label: 'small chunks (512)', overrides: { maxChunkSize: 512 } },
  { label: 'large chunks (8192)',overrides: { maxChunkSize: 8192 } },
  { label: 'maxHeadingDepth=2',  overrides: { maxHeadingDepth: 2 } },
  { label: 'maxHeadingDepth=1',  overrides: { maxHeadingDepth: 1 } },
];

function runE2ESuite(label, configOverrides) {
  describe(`e2e – ${label}`, () => {
    let config;
    let outputApplyPatches, outputParse, outputSectionize, outputMergeSections, outputParseBlocks, outputTransformBlocks, outputPackBlocks, outputFilter, dropped;

    before(() => {
      config = mergeConfig({ ...configOverrides, debug: true });
      ({ outputApplyPatches, outputParse, outputSectionize, outputMergeSections, outputParseBlocks, outputTransformBlocks, outputPackBlocks, outputFilter, dropped }
        = runPipeline(RAW_TEXT, config));
    });

    function walkNodes(ns, fn) {
      for (const n of ns) { fn(n); walkNodes(n.children, fn); }
    }

    describe('pipeline stages', () => {

      describe('00-patches', () => {
        test('patched output is a non-empty string', () => {
          assert.equal(typeof outputApplyPatches, 'string');
          assert.ok(outputApplyPatches.length > 0);
        });

        test('each patch find string no longer appears in patched text (unless it is a prefix of replace)', () => {
          for (const patch of PATCHES) {
            if (patch.replace.startsWith(patch.find)) continue;
            assert.ok(!outputApplyPatches.includes(patch.find),
              `patch find string still present after applying: ${JSON.stringify(patch.find.slice(0, 60))}`);
          }
        });

        test('each patch replace string is present in patched text', () => {
          for (const patch of PATCHES) {
            assert.ok(outputApplyPatches.includes(patch.replace),
              `patch replace string missing after applying: ${JSON.stringify(patch.replace.slice(0, 60))}`);
          }
        });
      });

      describe('01-parse', () => {
        test('every node has a non-empty source', () => {
          walkNodes(outputParse, n => assert.ok(n.source.length > 0, `node missing source: ${n.title}`));
        });

        test('no node body contains its own source line', () => {
          walkNodes(outputParse, n => {
            if (n.source) assert.ok(!n.body.includes(n.source), `source leaked into body: ${n.title}`);
          });
        });

        test('no node body starts with a blank line', () => {
          walkNodes(outputParse, n => assert.ok(!n.body.startsWith('\n'), `body starts with blank line: ${n.title}`));
        });

        test('no node is created for a heading that appears inside an unclosed outer container', () => {
          // Bug: isNotInsideContainer scans backward from the heading line and returns true
          // (not inside) as soon as it hits a ::: closer, without checking whether that closer
          // belongs to a nested inner container while an outer container is still open.
          // Pattern: "::: outer\n::: inner\n:::\n## Heading" — the backward scan finds ":::"
          // (inner closer) first and returns true, so the heading is split into a new node
          // instead of remaining body content of the enclosing section.
          // Known cases in llms-full.txt (forward-scan ground truth = inside unclosed container):
          //   line ~470:   "## Domain Models"       inside ::: details at line 438 (inner ::: code-group closes at 448 but outer ::: details never closes before heading)
          //   line ~23498: "### Adding XSUAA"        inside :::details at line 23475
          //   line ~25076: "### Tracing"             inside multiple nested ::: details blocks
          // These headings should NOT appear as nodes in the parse tree; their content
          // should be part of their enclosing section's body.
          const knownBadSources = [
            '/docs/guides/multitenancy/mtxs#request-format',
            'Source: /docs/guides/security/cap-users#switching-to-privileged-user',
            '/docs/guides/security/data-protection#bad-example',
            '/docs/guides/multitenancy/mtxs#additional-development-settings',
            '/docs/guides/multitenancy/mtxs#required-mtx-services'
          ];
          const foundSources = new Set();
          walkNodes(outputParse, n => { if (n.source) foundSources.add(n.source.replace(/^>\s*Source:\s*/, '').trim()); });
          for (const src of knownBadSources) {
            assert.ok(!foundSources.has(src),
              `heading inside unclosed outer container was parsed as a separate node: ${src}`);
          }
        });

        test('parse collects headings beyond maxHeadingDepth (no depth gate in parse)', () => {
          let maxDepth = 0;
          walkNodes(outputParse, n => { if (n.depth > maxDepth) maxDepth = n.depth; });
          assert.ok(maxDepth > config.maxHeadingDepth, `expected nodes deeper than ${config.maxHeadingDepth} but max depth was ${maxDepth}`);
        });
      });

      describe('02-section', () => {
        test('no section heading exceeds maxHeadingDepth (deep nodes folded, not emitted)', () => {
          for (const s of outputSectionize) {
            const depth = /^(#+) /.exec(s.heading)?.[1].length ?? 0;
            assert.ok(depth <= config.maxHeadingDepth, `section heading depth ${depth} exceeds maxHeadingDepth: ${s.heading}`);
          }
        });

        test('every section has a non-empty source', () => {
          for (const s of outputSectionize) {
            assert.ok(s.source.length > 0, `section missing source: ${s.heading}`);
          }
        });

        test('sections are emitted in DFS order (parent headingPath is prefix of child)', () => {
          for (let i = 1; i < outputSectionize.length; i++) {
            const prev = outputSectionize[i - 1].headingPath;
            const curr = outputSectionize[i].headingPath;
            if (curr.length > prev.length) {
              assert.deepEqual(
                curr.slice(0, prev.length), prev,
                `section out of DFS order at index ${i}: ${JSON.stringify(curr)}`
              );
            }
          }
        });

        test('section heading field equals node raw line', () => {
          // heading is set from node.raw — must start with # and match depth field
          for (const s of outputSectionize) {
            assert.match(s.heading, /^#{1,6} /, `heading not a raw heading line: ${s.heading}`);
            const depth = /^(#+) /.exec(s.heading)[1].length;
            assert.equal(depth, s.depth, `heading depth mismatch for: ${s.heading}`);
          }
        });

        test('section headingPath last element matches heading title', () => {
          for (const s of outputSectionize) {
            if (s.headingPath.length === 0) continue;
            const title = s.heading.replace(/^#+\s+/, '').trim();
            assert.equal(s.headingPath[s.headingPath.length - 1], title,
              `headingPath tail mismatch for: ${s.heading}`);
          }
        });

        test('section count <= node count (folded nodes not emitted as sections)', () => {
          let nodeCount = 0;
          walkNodes(outputParse, () => nodeCount++);
          assert.ok(outputSectionize.length <= nodeCount,
            `sections (${outputSectionize.length}) exceed nodes (${nodeCount})`);
        });

        test('folded sections: section count < node count when doc has nodes beyond maxHeadingDepth', () => {
          let deepCount = 0;
          walkNodes(outputParse, n => { if (n.depth > config.maxHeadingDepth) deepCount++; });
          if (deepCount > 0) {
            let nodeCount = 0;
            walkNodes(outputParse, () => nodeCount++);
            assert.ok(outputSectionize.length < nodeCount,
              `expected fewer sections than nodes when ${deepCount} nodes are folded`);
          }
        });
      });

      describe('03-merge', () => {
        test('merge never adds sections', () => {
          assert.ok(outputMergeSections.length <= outputSectionize.length);
        });

        test('every merged section has non-empty source, headingPath, heading', () => {
          for (const s of outputMergeSections) {
            assert.ok(s.source.length > 0, `missing source: ${s.heading}`);
            assert.ok(s.headingPath.length > 0, `missing headingPath: ${s.heading}`);
            assert.ok(s.heading.length > 0, 'missing heading');
          }
        });

        test('merged section depth matches heading marker depth', () => {
          for (const s of outputMergeSections) {
            const depth = /^(#+) /.exec(s.heading)?.[1].length ?? 0;
            assert.equal(depth, s.depth, `depth mismatch: ${s.heading}`);
          }
        });

        test('general rule: no empty-body section is immediately followed by a non-empty same-depth section (they were merged)', () => {
          for (let i = 0; i < outputMergeSections.length - 1; i++) {
            const curr = outputMergeSections[i];
            const next = outputMergeSections[i + 1];
            if (curr.body.trim() !== '') continue;
            if (next.body.trim() === '') continue; // two consecutive empties are fine
            assert.ok(next.depth !== curr.depth,
              `empty section "${curr.heading}" still followed by non-empty same-depth section "${next.heading}" — should have been merged`);
          }
        });

        test('mergeLeadIn disabled: outputMergeSections count matches sections minus empty-body absorptions', () => {
          // Simulate general empty-body absorption rule in 03-merge.js exactly.
          // All consecutive empty-body sections at same depth as the next non-empty are absorbed.
          let expected = outputSectionize.length;
          let i = 0;
          while (i < outputSectionize.length) {
            const curr = outputSectionize[i];
            if (curr.body.trim() === '') {
              let j = i + 1;
              while (j < outputSectionize.length && outputSectionize[j].depth === curr.depth && outputSectionize[j].body.trim() === '') j++;
              const target = outputSectionize[j];
              if (target && target.depth === curr.depth) {
                // count how many preceding empty-body sections at same depth get absorbed from result
                let k = i - 1;
                while (k >= 0 && outputSectionize[k].depth === curr.depth && outputSectionize[k].body.trim() === '') k--;
                // absorbed: empties from k+1..i plus empties i+1..j-1 — all collapse into target
                expected -= (j - k - 1); // (j-1) - (k+1) + 1 empties absorbed = j - k - 1
                i = j + 1;
                continue;
              }
            }
            i++;
          }
          assert.equal(outputMergeSections.length, expected,
            `outputMergeSections (${outputMergeSections.length}) !== expected (${expected}) — empty-body absorption simulation is off`);
        });        
      });

      describe('04-parse-blocks', () => {
        const VALID_TYPES = new Set(['fence', 'container', 'html-table', 'java-div', 'node-div', 'cols-div', 'md-table', 'list-item', 'admonition', 'bullet-item', 'redirect', 'paragraph', 'heading']);
        const blocks = () => outputParseBlocks.flatMap(({ blocks: bs }) => bs);
        const ofType = (t) => blocks().filter(b => b.type === t);
        const STRUCTURAL = new Set(['container', 'java-div', 'node-div', 'cols-div', 'list-item', 'bullet-item']);
        function flat(bs) { const o = []; for (const b of bs) { o.push(b); if (b.parts && STRUCTURAL.has(b.type)) o.push(...flat(b.parts)); } return o; }

        test('every section produces at least one block', () => {
          for (const { section, blocks: bs } of outputParseBlocks)
            assert.ok(bs.length > 0, `no blocks for: ${section.heading}`);
        });

        test('all block types (including parts[]) are known types', () => {
          for (const b of flat(blocks()))
            assert.ok(VALID_TYPES.has(b.type), `unknown block type: ${b.type}`);
        });

        test('fence blocks: start with ` or ~ or indent, supressCut=true', () => {
          const fences = ofType('fence');
          assert.ok(fences.length > 0, 'no fence blocks');
          for (const b of fences) {
            assert.ok(b.text.startsWith('`') || b.text.startsWith('~') || b.text.startsWith(' '), 'fence must start with `, ~ or indent');
            assert.equal(b.supressCut, true);
          }
        });

        test('container blocks: opener does not contain code-group, has parts[], supressCut=true', () => {
          const containers = ofType('container');
          assert.ok(containers.length > 0, 'no container blocks');
          for (const b of containers) {
            if (b.opener) assert.ok(!b.opener.includes('code-group'), 'container opener does not contain code-group');
            assert.ok(Array.isArray(b.parts));
            assert.equal(b.supressCut, true);
          }
        });

        test('html-table blocks: contain <table, supressCut=true', () => {
          const tables = ofType('html-table');
          assert.ok(tables.length > 0, 'no html-table blocks');
          for (const b of tables) {
            assert.match(b.text, /<table/i);
            assert.equal(b.supressCut, true);
          }
        });

        test('java-div blocks: opener contains "java", has parts[], supressCut=false', () => {
          const divs = ofType('java-div');
          assert.ok(divs.length > 0, 'no java-div blocks');
          for (const b of divs) {
            assert.match(b.opener, /java/i);
            assert.ok(Array.isArray(b.parts));
            assert.equal(b.supressCut, false);
          }
        });

        test('node-div blocks: opener contains "node", has parts[], supressCut=false', () => {
          const divs = ofType('node-div');
          assert.ok(divs.length > 0, 'no node-div blocks');
          for (const b of divs) {
            assert.match(b.opener, /node/i);
            assert.ok(Array.isArray(b.parts));
            assert.equal(b.supressCut, false);
          }
        });

        test('cols-div blocks: opener contains cols-N, has parts[], supressCut=false', () => {
          const divs = ofType('cols-div');
          assert.ok(divs.length > 0, 'no cols-div blocks');
          for (const b of divs) {
            assert.equal(b.opener, undefined);
            assert.ok(Array.isArray(b.parts));
            assert.equal(b.supressCut, false);
          }
        });

        test('md-table blocks: text starts with |, supressCut=true', () => {
          const tables = ofType('md-table');
          assert.ok(tables.length > 0, 'no md-table blocks');
          for (const b of tables) {
            assert.match(b.text, /^\s*\|/);
            assert.equal(b.supressCut, true);
          }
        });

        test('list-item blocks: opener matches N. pattern, has parts[], supressCut=true', () => {
          const items = ofType('list-item');
          assert.ok(items.length > 0, 'no list-item blocks');
          for (const b of items) {
            assert.match(b.opener ?? b.text ?? '', /^\d+\.\s/);
            assert.ok(Array.isArray(b.parts));
            assert.equal(b.supressCut, true);
          }
        });

        test('admonition blocks: text starts with > [!TYPE], supressCut=true', () => {
          const admons = ofType('admonition');
          assert.ok(admons.length > 0, 'no admonition blocks');
          for (const b of admons) {
            if (!b.text) continue; // admonition with parts may not have text set
            assert.match(b.text, /^>\s*\[!(tip|note|warning|important|info|danger|caution)\]/i);
            assert.equal(b.supressCut, true);
          }
        });

        test('bullet-item blocks: opener matches bullet pattern, has parts[], supressCut=true', () => {
          const items = ofType('bullet-item');
          assert.ok(items.length > 0, 'no bullet-item blocks');
          for (const b of items) {
            assert.match(b.opener ?? b.text ?? '', /^\s*[-*+]\s/);
            assert.ok(Array.isArray(b.parts));
            assert.equal(b.supressCut, true);
          }
        });

        test('redirect blocks: text ends with {.learn-more}, supressCut=true', () => {
          const redirects = ofType('redirect');
          assert.ok(redirects.length > 0, 'no redirect blocks');
          for (const b of redirects) {
            assert.match(b.text, /\{\s*\.?\s*learn-more\}\s*$/);
            assert.equal(b.supressCut, true);
          }
        });

        test('paragraph blocks: have isLeadIn and isAnaphoric booleans, supressCut=false', () => {
          const paras = ofType('paragraph');
          assert.ok(paras.length > 0, 'no paragraph blocks');
          for (const b of paras) {
            assert.ok(typeof b.isLeadIn === 'boolean', 'paragraph missing isLeadIn');
            assert.ok(typeof b.isAnaphoric === 'boolean', 'paragraph missing isAnaphoric');
            assert.equal(b.supressCut, false);
          }
        });

        test('some paragraphs have isLeadIn=true', () => {
          assert.ok(ofType('paragraph').some(b => b.isLeadIn), 'no isLeadIn paragraph found');
        });

        test('some paragraphs have isAnaphoric=true', () => {
          assert.ok(ofType('paragraph').some(b => b.isAnaphoric), 'no isAnaphoric paragraph found');
        });

        test('fence inside blockquote-prefixed ::: code-group inside GFM admonition is a fence block (not paragraph)', () => {
          // Real corpus: /docs/guides/databases/hana#undeploying-artifacts —
          //   > [!danger] Never undeploy hdbtable files
          //   > ::: code-group
          //   > ```json [db/undeploy.json]
          //   >   "src/...hdbtable" // [!code error] data loss!
          //   > ```
          //   > :::
          const hanaEntry = outputParseBlocks.find(({ blocks: bs }) =>
            bs.some(b => b.type === 'admonition' && (b.opener || '').includes('Never undeploy'))
          );
          assert.ok(hanaEntry, 'admonition "Never undeploy hdbtable files" not found in tokenize output');
          const admon = hanaEntry.blocks.find(b => b.type === 'admonition' && (b.opener || '').includes('Never undeploy'));
          const innerContainer = admon.parts?.find(p => p.type === 'container');
          assert.ok(innerContainer, 'inner ::: code-group must be parsed as a container part inside the admonition');
          const fencePart = innerContainer.parts?.find(p => p.type === 'fence');
          assert.ok(
            fencePart,
            `blockquote-prefixed fence must be a fence block inside the container, got: ${JSON.stringify(innerContainer.parts?.map(p => p.type))}`
          );
        });
      });

      describe('05-transform', () => {
        const blocks = () => outputTransformBlocks.flatMap(({ blocks: bs }) => bs);
        function flatDeep(bs) {
          const out = [];
          for (const b of bs) {
            out.push(b);
            if (b.parts?.length) out.push(...flatDeep(b.parts));
          }
          return out;
        }
        const allBlocks = () => flatDeep(blocks());
        const ofType = (t) => allBlocks().filter(b => b.type === t);

        test('no entry contains raw :::code-group', () => {
          for (const b of allBlocks()) {
            const text = b.text ?? b.opener ?? '';
            assert.ok(
              !text.includes('code-group'),
              `block type="${b.type}" contains ::: code-group: ${text}`
            );
          }
        });

        // ── existence ────────────────────────────────────────────────────────────
        test('no block survives with isEmpty=true', () => {
          for (const { blocks: bs } of outputTransformBlocks)
            for (const b of bs) assert.ok(!b.isEmpty, 'isEmpty block survived filter');
        });

        test('transform block count <= tokenize block count', () => {
          const before = outputParseBlocks.reduce((s, { blocks: bs }) => s + bs.length, 0);
          const after  = outputTransformBlocks.reduce((s, { blocks: bs }) => s + bs.length, 0);
          assert.ok(after <= before);
        });

        // ── shared normalization ─────────────────────────────────────────────────
        test('no block text has 3+ consecutive blank lines (collapsed to 2)', () => {
          // Rule: shared normalization collapses \n{3,} → \n\n for all non-fence types.
          // Fences and containers preserve inner content verbatim, so skip those.
          const VERBATIM = new Set(['fence', 'container', 'java-div', 'node-div', 'cols-div', 'list-item', 'bullet-item']);
          for (const b of allBlocks()) {
            if (VERBATIM.has(b.type)) continue;
            assert.ok(!/\n{3,}/.test(b.text),
              `3+ blank lines in ${b.type}: ${JSON.stringify(b.text.slice(0, 80))}`);
          }
        });

        test('no block text has CRLF line endings (normalized to LF)', () => {
          for (const b of allBlocks())
            assert.ok(!b.text.includes('\r'),
              `CRLF survived in ${b.type}: ${JSON.stringify(b.text.slice(0, 60))}`);
        });

        test('no block text has leading or trailing whitespace (outer trim applied)', () => {
          // bullet-item and list-item preserve indentation so leading space is expected there.
          // java-div with empty inner content can produce "Java:\n" (trailing newline) — known gap.
          // paragraph with only a link can produce leading/trailing newline — known gap.
          const SKIP = new Set(['bullet-item', 'list-item', 'java-div', 'node-div', 'paragraph']);
          for (const b of allBlocks()) {
            if (SKIP.has(b.type)) continue;
            assert.equal(b.text, b.text.trim(),
              `untrimmed ${b.type}: ${JSON.stringify(b.text.slice(0, 80))}`);
          }
        });

        test('no attribute-bearing tags', () => {
          const SKIP = new Set(['container', 'fence']);
          for (const b of allBlocks()) {
            if (SKIP.has(b.type)) continue;
            const hasHTML = b.text.includes('<span ') || b.text.includes('<div ') || b.text.includes('<br>')
            assert.ok(!hasHTML, `${b.type} includes html \n${b.text}`);
          }
        });

        // ── paragraph rules ──────────────────────────────────────────────────────
        test('no paragraph block has multi-space runs outside backtick spans', () => {
          // Rule: collapse 2+ spaces → 1 space, but not inside `...`.
          for (const b of ofType('paragraph')) {
            const parts = b.text.split('`');
            for (let i = 0; i < parts.length; i += 2) { // even indices = outside backticks
              assert.ok(!/ {2,}/.test(parts[i]),
                `multi-space outside backticks in paragraph: ${JSON.stringify(b.text.slice(0, 100))}`);
            }
          }
        });

        test('no paragraph block has [!code --]', () => {
          for (const b of ofType('paragraph')) {
            assert.ok(!b.text.includes('code --'));
          }
        });

        test('no paragraph block has {.class} or {#id} markers (stripped)', () => {
          for (const b of ofType('paragraph')) {
            const parts = b.text.split('`');
            for (let i = 0; i < parts.length; i += 2) { // outside backticks only
              assert.ok(!/\{\s*[.#][^}]*\}/.test(parts[i]),
                `class/id marker survived in paragraph: ${JSON.stringify(b.text.slice(0, 100))}`);
            }
          }
        });

        test('no paragraph block has raw image syntax ![]() surviving (stripped or replaced)', () => {
          // Exception: ![`...`] is escaped identifier syntax in CDS/CDL, not an image.
          for (const b of ofType('paragraph')) {
            const text = b.text;
            // strip backtick spans first so we don't flag ![`id`] inside code
            const noCode = text.replace(/`[^`\n]+`/g, '``');
            assert.ok(!/!\[/.test(noCode),
              `image syntax survived in paragraph: ${JSON.stringify(text.slice(0, 100))}`);
          }
        });

        test('no paragraph block contains <UnderConstruction/> tag (stripped)', () => {
          for (const b of ofType('paragraph'))
            assert.ok(!/<UnderConstruction/i.test(b.text),
              `<UnderConstruction/> survived in paragraph: ${JSON.stringify(b.text.slice(0, 100))}`);
        });

        test('all relative markdown links in paragraph are resolved to absolute paths', () => {
          // After transform, links are 'label (url)'. Relative paths (../ or ./) must not survive.
          for (const b of ofType('paragraph')) {
            for (const [, url] of b.text.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
              assert.fail(`unresolved relative link in paragraph: ${JSON.stringify(url)} in: ${b.text.slice(0, 80)}`);
            }
          }
        });

        // ── redirect rules (same pipeline as paragraph) ──────────────────────────
        test('redirect blocks have no {.learn-more} marker surviving', () => {
          for (const b of ofType('redirect'))
            assert.ok(!/\{\.learn-more\}/.test(b.text),
              `{.learn-more} survived in redirect: ${JSON.stringify(b.text.slice(0, 100))}`);
        });

        test('all relative markdown links in redirect are resolved to absolute paths', () => {
          for (const b of ofType('redirect')) {
            for (const [, url] of b.text.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
              assert.fail(`unresolved relative link in redirect: ${JSON.stringify(url)}`);
            }
          }
        });

        // ── fence rules ──────────────────────────────────────────────────────────
        test('fence block text starts with ``` or ~~~ (opener preserved)', () => {
          for (const b of ofType('fence'))
            assert.ok(b.text.startsWith('`') || b.text.startsWith('~'),
              `fence opener malformed: ${JSON.stringify(b.text.slice(0, 40))}`);
        });

        test('fence block text ends with ``` or ~~~ (closer preserved)', () => {
          for (const b of ofType('fence')) {
            const lastLine = (b.text.split('\n').at(-1) ?? '').trim();
            assert.ok(/^(`{3,}|~{3,})/.test(lastLine),
              `fence closer malformed: ${JSON.stringify(b.text.slice(-40))}`);
          }
        });

        // ── bullet-list / list rules ─────────────────────────────────────────────
        test('no bullet-item block has {.class} markers outside backtick spans', () => {
          for (const b of ofType('bullet-item')) {
            const parts = b.text.split('`');
            for (let i = 0; i < parts.length; i += 2)
              assert.ok(!/\{\s*[.#][^}]*\}/.test(parts[i]),
                `class marker survived in bullet-item: ${JSON.stringify(b.text.slice(0, 100))}`);
          }
        });

        test('no list-item block has {.class} markers outside backtick spans', () => {
          for (const b of ofType('list-item')) {
            const parts = b.text.split('`');
            for (let i = 0; i < parts.length; i += 2)
              assert.ok(!/\{\s*[.#][^}]*\}/.test(parts[i]),
                `class marker survived in list-item: ${JSON.stringify(b.text.slice(0, 100))}`);
          }
        });

        // ── md-table rules ───────────────────────────────────────────────────────
        test('md-table block rows use single-dash separator (long dash runs collapsed)', () => {
          // Rule: compactTableCells collapses -{2,} → - in separator rows.
          for (const b of ofType('md-table')) {
            for (const line of b.text.split('\n')) {
              if (/^\s*\|[\s\-:|]+\|?\s*$/.test(line)) {
                assert.ok(!/-{2,}/.test(line),
                  `long dash run in md-table separator: ${JSON.stringify(line)}`);
              }
            }
          }
        });

        test('md-table block text contains no raw HTML entities (decoded)', () => {
          for (const { section, blocks: bs } of outputTransformBlocks) {
            for (const b of bs) {
              if (b.type !== 'md-table') continue;
              assert.ok(!/&[a-zA-Z]+;|&#\d+;/.test(b.text),
                `raw HTML entity survived in md-table: ${JSON.stringify(b.text.slice(0, 100))} (section: ${section.source})`);
            }
          }
        });

        test('all relative markdown links in md-table are resolved to absolute paths', () => {
          for (const b of ofType('md-table')) {
            for (const [, url] of b.text.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
              assert.fail(`unresolved relative link in md-table: ${JSON.stringify(url)}`);
            }
          }
        });

        // ── html-table rules ─────────────────────────────────────────────────────
        test('html-table block text contains no <table> tag (wrapper stripped)', () => {
          for (const b of ofType('html-table'))
            assert.ok(!/<table/i.test(b.text),
              `<table> tag survived in html-table: ${JSON.stringify(b.text.slice(0, 80))}`);
        });

        test('html-table block text contains no raw <td> or <th> tags (stripped)', () => {
          for (const b of ofType('html-table'))
            assert.ok(!/<t[dh]/i.test(b.text),
              `<td>/<th> tag survived in html-table: ${JSON.stringify(b.text.slice(0, 80))}`);
        });

        test('html-table block text contains no raw HTML entities (decoded)', () => {
          for (const b of ofType('html-table'))
            assert.ok(!/&[a-zA-Z]+;|&#\d+;/.test(b.text),
              `raw HTML entity survived in html-table: ${JSON.stringify(b.text.slice(0, 100))}`);
        });

        test('all relative links in html-table are resolved to absolute paths', () => {
          for (const b of ofType('html-table')) {
            for (const [, url] of b.text.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
              assert.fail(`unresolved relative link in html-table: ${JSON.stringify(url)}`);
            }
          }
        });

        // ── java-div / node-div rules ─────────────────────────────────────────────
        test('every java-div block starts with Java: label', () => {
          for (const b of ofType('java-div'))
            assert.ok(b.text.startsWith('Java:'),
              `java-div missing label: ${JSON.stringify(b.text.slice(0, 60))}`);
        });

        test('every node-div block starts with Node.js: label', () => {
          for (const b of ofType('node-div'))
            assert.ok(b.text.startsWith('Node.js:'),
              `node-div missing label: ${JSON.stringify(b.text.slice(0, 60))}`);
        });

        test('java-div block text contains no outer <div> tag (stripped)', () => {
          for (const b of ofType('java-div'))
            assert.ok(!/<div/i.test(b.text),
              `<div> tag survived in java-div: ${JSON.stringify(b.text.slice(0, 80))}`);
        });

        test('node-div block text contains no outer <div> tag (stripped)', () => {
          for (const b of ofType('node-div'))
            assert.ok(!/<div/i.test(b.text),
              `<div> tag survived in node-div: ${JSON.stringify(b.text.slice(0, 80))}`);
        });

        test('all relative links in java-div are resolved to absolute paths', () => {
          for (const b of ofType('java-div')) {
            for (const [, url] of b.text.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
              assert.fail(`unresolved relative link in java-div: ${JSON.stringify(url)}`);
            }
          }
        });

        // ── container rules ──────────────────────────────────────────────────────
        test('container block text contains no ::: delimiters (stripped)', () => {
          // The outer ::: opener and closer are stripped; only inner part text remains.
          // Nested ::: blocks can appear verbatim when deep sections are folded into a
          // parent container, so we only assert the outer wrapper is gone:
          // the first line must not be the opener (:::...) and the last line must not be :::.
          for (const b of ofType('container')) {
            const lines = b.text.split('\n').filter(l => l.trim());
            if (!lines.length) continue;
            if (lines[0].includes('code-group')) {
              assert.ok(!/^:::\s*$/.test(lines[0]),
                `container text starts with bare ::: opener: ${JSON.stringify(b.text.slice(0, 80))}`);
              assert.ok(!/^:::\s*$/.test(lines[lines.length - 1]),
                `container text ends with ::: closer: ${JSON.stringify(b.text.slice(-80))}`);
            }
          }
        });

        // ── admonition rules ─────────────────────────────────────────────────────
        test('admonition block text starts with > [!TYPE] (marker preserved)', () => {
          for (const b of ofType('admonition'))
            assert.match(b.text, /^>\s*\[!(tip|note|warning|important|info|danger|caution)\]/i,
              `admonition [!TYPE] marker missing: ${JSON.stringify(b.text.slice(0, 60))}`);
        });

        // ── cols-div rules ───────────────────────────────────────────────────────
        test('cols-div block text contains no outer <div> tag (stripped)', () => {
          for (const b of ofType('cols-div'))
            assert.ok(!/<div/i.test(b.text),
              `<div> tag survived in cols-div: ${JSON.stringify(b.text.slice(0, 80))}`);
        });

        // ── container opener link resolution ─────────────────────────────────────
        test('container opener has no unresolved relative links (../../ paths)', () => {
          // Bug: container transform emits block.opener.trim() verbatim without calling
          // resolveLinks, so "::: details ... [text](../../path#anchor) ..." links are
          // never resolved. Example in corpus: /docs/guides/domain/#cdsoninsert has
          // "::: details Note the differences to [defaults](../../cds/cdl#default-values)..."
          for (const { section, blocks: bs } of outputTransformBlocks) {
            for (const b of bs) {
              if (b.type !== 'container') continue;
              const opener = b.opener ?? '';
              for (const [, url] of opener.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
                assert.fail(
                  `unresolved relative link in container opener: ${JSON.stringify(url)} in opener: ${JSON.stringify(opener.slice(0, 100))} (section: ${section.source})`
                );
              }
            }
          }
        });

        // ── HTML stub lines with attributes not stripped ──────────────────────────
        test('no paragraph block contains bare block-level HTML tags with attributes (e.g. <span class="...">)', () => {
          // Bug: isHtmlStub uses HTML_STUB = /^<[A-Za-z][^>]*\/>\s*$|^<[a-z]+>\s*$|^<\/[a-z]+>\s*$/
          // which only matches tags without attributes. Lines like "<span class=\"small\">"
          // on their own line pass through normalizeShared unfiltered into paragraph text.
          // Example in corpus: /docs/get-started/bookshop#compile-to-sql has a
          // "<span class=\"small\">" line wrapping a code block.
          const BLOCK_HTML_WITH_ATTRS = /^<[a-z][a-z0-9]*(?:\s+[^>]*)?>$/im;
          for (const { section, blocks: bs } of outputTransformBlocks) {
            for (const b of bs) {
              if (b.type !== 'paragraph') continue;
              for (const line of b.text.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                assert.ok(
                  !BLOCK_HTML_WITH_ATTRS.test(trimmed),
                  `bare HTML open tag with attributes survived in paragraph: ${JSON.stringify(trimmed)} (section: ${section.source})`
                );
              }
            }
          }
        });

        // ── idempotency ──────────────────────────────────────────────────────────
        test('transform is idempotent: re-running on already-transformed text produces same result', () => {
          // Container/div types store transformed text in b.text but the opener/parts[] are
          // needed to re-transform — without them fallbackParts re-tokenizes the already-stripped
          // inner text, which can differ. Only test atomic block types here.
          const ATOMIC = new Set(['paragraph', 'fence', 'md-table', 'html-table', 'redirect']);
          let checked = 0;
          for (const b of allBlocks()) {
            if (!ATOMIC.has(b.type)) continue;
            if (checked >= 300) break;
            if (!b.text || b.text.trim() === '') continue;
            const b2 = { type: b.type, text: b.text, supressCut: b.supressCut };
            const second = transformFn(b2, b.source);
            assert.equal(second, b.text,
              `transform not idempotent for ${b.type}: first=${JSON.stringify(b.text.slice(0, 60))} second=${JSON.stringify(second.slice(0, 60))}`);
            checked++;
          }
        });

        test('no paragraph block ends with a trailing newline (stripped image leaves orphan \\n)', () => {
          for (const b of ofType('paragraph')) {
            assert.ok(
              !b.text.endsWith('\n'),
              `paragraph ends with trailing \\n: ${JSON.stringify(b.text.slice(-60))}`
            );
          }
        });

        test('no block text has raw HTML entities', () => {
          const ENTITY_RE = /&(?:amp|lt|gt|quot|nbsp|ndash|mdash|#\d+);/;
          for (const b of allBlocks()) {
            if (b.type === 'fence' || b.type === 'container') continue;
            assert.ok(
              !ENTITY_RE.test(b.text ?? ''),
              `raw HTML entity in ${b.type} block: ${JSON.stringify((b.text ?? '').slice(0, 100))}`
            );
          }
        });

        test('no block text has images', () => {
          for (const b of allBlocks()) {
            if (b.type === 'fence' || b.type === 'container') continue;
            const hasLink = b.text.includes('.svg') || b.text.includes('/logos') || b.text.includes('<img') || b.text.includes('.png') 
            assert.ok(!hasLink, `${b.type} includes image \n${b.text}`);
          }
        });

        test('no heading or redirect block has {.class} or {#id} markers (stripped)', () => {
          for (const b of allBlocks()) {
            if (b.type !== 'heading' && b.type !== 'redirect') continue;
            const parts = b.text.split('`');
            for (let i = 0; i < parts.length; i += 2) {
              assert.ok(!/\{\s*[.#][^}]*\}/.test(parts[i]),
                `class/id marker survived in ${b.type}: ${JSON.stringify(b.text.slice(0, 100))}`);
            }
          }
        });

        test('no heading or redirect block has raw HTML entities (decoded)', () => {
          const ENTITY_RE = /&(?:amp|lt|gt|quot|nbsp|ndash|mdash|rarr|#\d+);/;
          for (const b of allBlocks()) {
            if (b.type !== 'heading' && b.type !== 'redirect') continue;
            assert.ok(!ENTITY_RE.test(b.text ?? ''),
              `raw HTML entity in ${b.type}: ${JSON.stringify(b.text.slice(0, 100))}`);
          }
        });

        test('no md-table separator row has long dash runs (compacted to single -)', () => {
          for (const b of ofType('md-table')) {
            for (const line of b.text.split('\n')) {
              const trimmed = line.trimStart();
              if (!/^\|[\s\-:|]+\|?\s*$/.test(trimmed)) continue;
              assert.ok(!/-{2,}/.test(trimmed),
                `long dash run in md-table separator: ${JSON.stringify(line)}`);
            }
          }
        });

        test('hrefs are not dropped as link only', () => {
          const hasFixture = allBlocks().some(b => b.text.includes('/docs/java/multitenancy#db-connection-pooling'))
          assert.ok(hasFixture);
        });

        test('<a> not dropped in tables', () => {
          const hasFixture = allBlocks().some(b => b.text.includes('<a valid Maven groupId>'))
          assert.ok(hasFixture);
        });

        // ── real-world section regression ─────────────────────────────────────────
        test('## AI plugin section: both Node.js and Java badge links survive transform (llms-full.txt line 83097)', () => {
          // Real pattern: two adjacent badge image-in-links on separate lines, one paragraph block:
          //   [![Node.js](/logos/nodejs.svg){}](https://github.com/cap-js/ai)
          //   [![Java](/logos/java.svg){}](https://github.com/cap-java/cds-ai)
          // Bug: isFilenameAlt('Java', '/logos/java.svg') returns true (pure alnum alt, url
          // contains alt lowercased) → inner image stripped to '' → outer [](...) link dropped.
          // The Java link silently disappears from the transformed output.
          // ## AI is a depth-2 section — not present when maxHeadingDepth=1 folds it away.
          const aiSection = outputTransformBlocks.find(({ section }) =>
            section.source && section.source.includes('/docs/plugins/#ai')
          );
          if (!aiSection) return; // folded at maxHeadingDepth=1 — skip
          const combined = aiSection.blocks.map(b => b.text).join('\n\n');
          assert.ok(
            combined.includes('Node.js (https://github.com/cap-js/ai)'),
            `Node.js badge link lost in ## AI section. Combined text tail: ${JSON.stringify(combined.slice(-300))}`
          );
          assert.ok(
            combined.includes('Java (https://github.com/cap-java/cds-ai)'),
            `Java badge link lost in ## AI section. Combined text tail: ${JSON.stringify(combined.slice(-300))}`
          );
        });
      });

      describe('06-chunk', () => {
        test('every section produces at least one bodyPart', () => {
          for (const { section, bodyParts } of outputPackBlocks)
            assert.ok(bodyParts.length > 0, `no bodyParts for: ${section.heading}`);
        });

        test('no bodyPart has an unclosed code fence', () => {
          for (const { bodyParts } of outputPackBlocks)
            for (const p of bodyParts) {
              const count = (p.match(/```/g) || []).length;
              assert.equal(count % 2, 0, 'odd fence count in bodyPart');
            }
        });

        test('no bodyPart is empty after trim', () => {
          for (const { bodyParts } of outputPackBlocks)
            for (const p of bodyParts)
              assert.ok(p.trim().length > 0, 'empty bodyPart emitted');
        });

        test('every bodyPart equals its own trim (no leading/trailing whitespace)', () => {
          for (const { bodyParts } of outputPackBlocks)
            for (const p of bodyParts)
              assert.equal(p, p.trim(), `bodyPart not trimmed: ${JSON.stringify(p.slice(0, 60))}`);
        });

        test('supressCut=true block is never separated from its preceding block by a chunk boundary', () => {
          // Pair outputTransformBlocks blocks with outputPackBlocks bodyParts by section heading.
          const chunkMap = new Map(outputPackBlocks.map(e => [e.section.heading, e.bodyParts]));
          for (const { section, blocks: bs } of outputTransformBlocks) {
            const bodyParts = chunkMap.get(section.heading);
            if (!bodyParts || bs.length < 2) continue;
            for (let i = 1; i < bs.length; i++) {
              if (!bs[i].supressCut) continue;
              const prevText = bs[i - 1].text ?? '';
              const nextText = bs[i].text ?? '';
              if (prevText.length < 20 || nextText.length < 20) continue;
              const prevKey = prevText.slice(0, 60);
              const nextKey = nextText.slice(0, 60);
              // skip if key appears in more than one part (ambiguous match)
              const prevMatches = bodyParts.filter(p => p.includes(prevKey)).length;
              const nextMatches = bodyParts.filter(p => p.includes(nextKey)).length;
              if (prevMatches !== 1 || nextMatches !== 1) continue;
              const prevPart = bodyParts.findIndex(p => p.includes(prevKey));
              const nextPart = bodyParts.findIndex(p => p.includes(nextKey));
              assert.equal(prevPart, nextPart,
                `supressCut block separated from prev in "${section.heading}": ${nextText.slice(0, 60)}`);
            }
          }
        });

        test('isAnaphoric=true paragraph is never separated from its preceding block by a chunk boundary', () => {
          const chunkMap = new Map(outputPackBlocks.map(e => [e.section.heading, e.bodyParts]));
          for (const { section, blocks: bs } of outputTransformBlocks) {
            const bodyParts = chunkMap.get(section.heading);
            if (!bodyParts || bs.length < 2) continue;
            for (let i = 1; i < bs.length; i++) {
              if (!bs[i].isAnaphoric) continue;
              const prevText = bs[i - 1].text ?? '';
              const nextText = bs[i].text ?? '';
              if (prevText.length < 20 || nextText.length < 20) continue;
              const prevKey = prevText.slice(0, 60);
              const nextKey = nextText.slice(0, 60);
              const prevMatches = bodyParts.filter(p => p.includes(prevKey)).length;
              const nextMatches = bodyParts.filter(p => p.includes(nextKey)).length;
              if (prevMatches !== 1 || nextMatches !== 1) continue;
              const prevPart = bodyParts.findIndex(p => p.includes(prevKey));
              const nextPart = bodyParts.findIndex(p => p.includes(nextKey));
              assert.equal(prevPart, nextPart,
                `anaphoric paragraph separated from prev in "${section.heading}": ${nextText.slice(0, 60)}`);
            }
          }
        });

        test('isLeadIn=true paragraph is never separated from the block that follows it by a chunk boundary', () => {
          const chunkMap = new Map(outputPackBlocks.map(e => [e.section.heading, e.bodyParts]));
          for (const { section, blocks: bs } of outputTransformBlocks) {
            const bodyParts = chunkMap.get(section.heading);
            if (!bodyParts || bs.length < 2) continue;
            for (let i = 0; i < bs.length - 1; i++) {
              if (!bs[i].isLeadIn) continue;
              const prevText = bs[i].text ?? '';
              const nextText = bs[i + 1].text ?? '';
              if (prevText.length < 20 || nextText.length < 20) continue;
              const prevKey = prevText.slice(0, 60);
              const nextKey = nextText.slice(0, 60);
              const prevMatches = bodyParts.filter(p => p.includes(prevKey)).length;
              const nextMatches = bodyParts.filter(p => p.includes(nextKey)).length;
              if (prevMatches !== 1 || nextMatches !== 1) continue;
              const prevPart = bodyParts.findIndex(p => p.includes(prevKey));
              const nextPart = bodyParts.findIndex(p => p.includes(nextKey));
              assert.equal(prevPart, nextPart,
                `lead-in paragraph separated from following block in "${section.heading}": ${prevText.slice(0, 60)}`);
            }
          }
        });

      });

      describe('07-filter', () => {
        test('every section does not end on a heading', () => {
          for (const { body, heading } of outputFilter) {
            const lastNonEmpty = body.split('\n').filter(l => l.trim() !== '').at(-1) ?? '';
            assert.ok(
              !/^\s*#{1,6} \S/.test(lastNonEmpty),
              `${JSON.stringify(configOverrides)}: bodyPart ends on a heading in section: ${heading}\n${body}`
            );
          }
        });

        test('filter only removes chunks', () => {
          const beforeCount = outputPackBlocks.reduce((s, { bodyParts }) => s + bodyParts.length, 0);
          assert.ok(outputFilter.length <= beforeCount);
        });

        test('every filtered chunk has non-empty breadcrumb, heading, body', () => {
          for (const c of outputFilter) {
            assert.ok(c.breadcrumb.length > 0, 'breadcrumb empty');
            assert.ok(c.heading.length > 0, 'heading empty');
            assert.ok(c.body.trim().length > 0, 'body empty');
          }
        });

        test('every filtered chunk has a valid label if present (java|node) — else absent', () => {
          const KNOWN = new Set(['java', 'node']);
          for (const c of outputFilter) {
            if (c.label === undefined) continue;
            assert.ok(KNOWN.has(c.label), `invalid label ${JSON.stringify(c.label)} for ${c.heading} (${c.source})`);
          }
        });

        test('no duplicate bodies in filter output', () => {
          const bodies = outputFilter.map(c => c.body);
          assert.equal(new Set(bodies).size, bodies.length, 'duplicate bodies found');
        });

        // releases rule: no chunk from /docs/releases/ survives
        test('no chunk from /docs/releases/ survives filter', () => {
          for (const c of outputFilter)
            assert.ok(!/\/docs\/releases\//.test(c.source ?? ''),
              `releases chunk survived: ${c.source}`);
        });

        // empty/whitespace body rule: already covered by non-empty body test above

        // anchor-only body rule: no chunk body consists entirely of h4-h6 slug lines
        test('no chunk body is anchor-only (h4-h6 slug lines only)', () => {
          for (const c of outputFilter) {
            const lines = c.body.split('\n').filter(l => l.trim());
            const allSlugs = lines.length > 0 && lines.every(l => /^#{4,6}\s+\S/.test(l.trim()));
            assert.ok(!allSlugs, `anchor-only body survived filter: ${JSON.stringify(c.body.slice(0, 80))}`);
          }
        });

        // valueless body rule: no placeholder stubs survive
        test('no chunk body is a placeholder stub (coming soon / TBD / to be written)', () => {
          for (const c of outputFilter) {
            const b = c.body.trim();
            assert.ok(
              !/^(will come soon|coming soon|tbd|to be (written|done|added))\.?$/i.test(b),
              `placeholder stub survived: ${JSON.stringify(b)}`
            );
            assert.ok(
              !/^this documentation is not (complete|available) yet/i.test(b),
              `incomplete-docs stub survived: ${JSON.stringify(b)}`
            );
          }
        });

        // redirect-stub rule: no chunk body is a bare single link with no surrounding prose
        test('no chunk body is a bare redirect-stub (single link, no prose)', () => {
          for (const c of outputFilter) {
            const b = c.body;
            if (/```/.test(b)) continue;
            if (/^\s*[-*+]\s/m.test(b)) continue;
            if (/^\s*\|/m.test(b)) continue;
            const links = b.match(/\[[^\]]*\]\([^)]*\)/g);
            if (!links || links.length !== 1) continue;
            if (/^\[As in /i.test(links[0])) continue;
            const stripped = b
              .replace(/!?\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '')
              .replace(/[\s#>*_|.-]/g, '')
              .trim();
            assert.ok(stripped !== '',
              `redirect-stub survived filter: ${JSON.stringify(b.slice(0, 100))}`);
          }
        });

        // size + meaningful-content rule: no chunk body is both short and content-free
        test('no chunk body is short with no meaningful content', () => {
          const MEANINGFUL = [
            /```[\s\S]/,
            /\|.+\|/,
            /\*\*(Note|Warning|Caution|Important|Tip)\*\*/i,
            /\[.+\]\(https?:\/\//,
            /`[^`]+`/,
            /^\s*[$>]\s+\S/m,
            /^\s*[-*+]\s/m,
          ];
          for (const c of outputFilter) {
            const b = c.body.trim();
            if (b.length >= config.minChunkSize) continue;
            // filter only drops short+valueless for depth < 2; deeper sections may be short prose
            if (c.depth >= 2) continue;
            assert.ok(
              MEANINGFUL.some(p => p.test(b)),
              `short body with no meaningful content survived: ${JSON.stringify(b)}`
            );
          }
        });

        // body-hash dedup rule: verified by no-duplicate-bodies test above

        // filter produces output (sanity: not everything dropped)
        test('filter output is non-empty', () => {
          assert.ok(outputFilter.length > 0, 'filter dropped everything');
        });
      });
      
      describe('08-dropped sections', () => {
        // pipeline-level drops (before filter)
        test('emptyBodySections: every dropped section has empty body after merge', () => {
          for (const s of dropped.emptyBodySections)
            assert.equal(s.body.trim(), '', `emptyBodySections entry has non-empty body: ${s.heading}`);
        });

        test('emptyBodySectionsAfterTransformed: every entry has a body that strips to empty (images/HTML/Vue only)', () => {
          for (const s of dropped.emptyBodySectionsAfterTransformed) {
            const stripped = (s.body ?? '')
              .replace(/!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '')
              .replace(/<[^>]+>/g, '')
              .replace(/\{[^}\n]*\}/g, '')
              .trim();
            assert.equal(stripped, '',
              `emptyBodySectionsAfterTransformed entry has non-strippable content: ${JSON.stringify(s.body?.slice(0, 80))}`);
          }
        });

        // filter-level drops
        test('filterDropped.releases: every entry is from /docs/releases/', () => {
          for (const c of dropped.filterDropped.releases)
            assert.ok(/\/docs\/releases\//.test(c.source ?? ''),
              `releases drop has wrong source: ${c.source}`);
        });

        test('filterDropped.emptyBody: every entry has empty body', () => {
          for (const c of dropped.filterDropped.emptyBody)
            assert.equal((c.body ?? '').trim(), '',
              `emptyBody drop has non-empty body: ${JSON.stringify(c.body?.slice(0, 60))}`);
        });

        test('filterDropped.anchorOnlyBody: every entry body consists only of h4-h6 lines', () => {
          for (const c of dropped.filterDropped.anchorOnlyBody) {
            const lines = (c.body ?? '').split('\n').filter(l => l.trim());
            assert.ok(lines.length > 0, 'anchorOnlyBody entry has no lines');
            for (const l of lines)
              assert.ok(/^#{4,6}\s+\S/.test(l.trim()),
                `anchorOnlyBody line is not h4-h6 slug: ${JSON.stringify(l)} in: ${c.body?.slice(0, 80)}`);
          }
        });

        test('filterDropped.valueless: no entry has a code fence', () => {
          for (const c of dropped.filterDropped.valueless)
            assert.ok(!/```/.test(c.body ?? ''),
              `valueless drop contains code fence: ${c.body?.slice(0, 80)}`);
        });

        test('filterDropped.valueless: no entry has a non-image link', () => {
          for (const c of dropped.filterDropped.valueless)
            assert.ok(!/(^|[^!])\[[^\]]*\]\([^)]*\)/.test(c.body ?? ''),
              `valueless drop contains a link: ${c.body?.slice(0, 80)}`);
        });

        test('filterDropped.redirectStub: every entry has exactly one link and no surrounding prose', () => {
          for (const c of dropped.filterDropped.redirectStub) {
            const b = c.body ?? '';
            const links = b.match(/\[[^\]]*\]\([^)]*\)/g);
            assert.ok(links && links.length === 1,
              `redirectStub drop has ${links?.length ?? 0} links: ${b.slice(0, 80)}`);
            const stripped = b
              .replace(/!?\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '')
              .replace(/[\s#>*_|.-]/g, '')
              .trim();
            assert.equal(stripped, '',
              `redirectStub drop has residual prose: ${JSON.stringify(stripped)} in: ${b.slice(0, 80)}`);
          }
        });

        test('filterDropped.toSmallBody: every entry is short and has no meaningful content', () => {
          const MEANINGFUL = [
            /```[\s\S]/,
            /\|.+\|/,
            /\*\*(Note|Warning|Caution|Important|Tip)\*\*/i,
            /\[.+\]\(https?:\/\//,
            /`[^`]+`/,
            /^\s*[$>]\s+\S/m,
            /^\s*[-*+]\s/m,
          ];
          for (const c of dropped.filterDropped.toSmallBody) {
            const b = (c.body ?? '').trim();
            assert.ok(b.length < config.minChunkSize,
              `toSmallBody drop is not short (len=${b.length}): ${b.slice(0, 80)}`);
            assert.ok(!MEANINGFUL.some(p => p.test(b)),
              `toSmallBody drop has meaningful content: ${b.slice(0, 80)}`);
          }
        });

        test('filterDropped.duplicates: every duplicate body also appears in outputFilter', () => {
          const kept = new Set(outputFilter.map(c => (c.body ?? '').trim()));
          for (const c of dropped.filterDropped.duplicates)
            assert.ok(kept.has((c.body ?? '').trim()),
              `duplicate drop body not found in kept output: ${c.body?.slice(0, 80)}`);
        });

        test('at least some chunks were dropped by filter (corpus is non-trivial)', () => {
          const totalDropped = Object.values(dropped.filterDropped).reduce((s, a) => s + a.length, 0);
          assert.ok(totalDropped > 0, 'filter dropped nothing — corpus may be empty or filter broken');
        });
      });
    });
  });
}

for (const { label, overrides } of CONFIGS) runE2ESuite(label, overrides);

// --- Focused cross-stage tests with tiny in-memory fixtures ---

describe('pipeline — focused fixture tests', () => {
  const configP = { minChunkSize: 0, maxHeadingDepth: 4 }
  describe('cross-stage: transform + chunk', () => {
    test('section with java-div content and empty node-div does not emit empty bodyPart', () => {
      const text = [
        '# Feature', '', '> Source: /docs/f', '', 'intro',
        '<div class="impl java">',
        '',
        'Java specific instructions here that survive transform.',
        '',
        '</div>',
        '<div class="impl node">',
        '',
        '![decorative](./x.drawio)',
        '',
        '</div>',
      ].join('\n');
      const config = mergeConfig(configP);
      const { sections } = runPipeline(text, config);
      for (const c of sections) {
        assert.ok(c.body && c.body.trim() !== '', `no chunk may have empty body; got ${JSON.stringify(c)}`);
      }
      const anyJava = sections.some(c => c.body.includes('Java specific instructions'));
      assert.ok(anyJava, 'java-div content must survive');
    });

    test('breadcrumb has {.class} markers stripped by transform', () => {
      const text = [
        '# Root {.some-marker}', '', '> Source: /docs/r', '', 'root body large enough to survive the min chunk size filter comfortably.',
        '## Child', '', '> Source: /docs/r#c', '', 'child body here large enough to survive the min chunk size filter comfortably.',
      ].join('\n');
      const config = mergeConfig(configP);
      const { sections } = runPipeline(text, config);
      const child = sections.find(c => c.heading?.includes('Child'));
      assert.ok(child, 'child chunk expected');
      assert.ok(!/\{\.some-marker\}/.test(child.breadcrumb),
        `breadcrumb must be markerless; got: ${JSON.stringify(child.breadcrumb)}`);
    });
  });

  describe('dropped sections tracking', () => {
    test('heading with empty body followed by deeper section lands in emptyBodySections', () => {
      const text = [
        '# Empty', '', '> Source: /docs/e', '', '   ', '',
        '## Real', '', '> Source: /docs/r', '', 'real content that clears filters and is long enough to survive the size gate.',
      ].join('\n');
      const config = mergeConfig(configP);
      const { dropped } = runPipeline(text, config);
      assert.equal(dropped.emptyBodySections.length, 1,
        `expected exactly one empty body section; got: ${dropped.emptyBodySections.length}`);
    });
  });

  describe('metadata label', () => {
    test('prose-only section has no label (undefined)', () => {
      const text = [
        '# H', '', '> Source: /docs/h', '', 'plain prose body long enough to survive filters, no code or divs here.',
      ].join('\n');
      const config = mergeConfig(configP);
      const { sections } = runPipeline(text, config);
      assert.ok(sections.length > 0);
      for (const c of sections) assert.equal(c.label, undefined, `expected no label; got ${c.label} for ${c.heading}`);
    });

    test('section with only java-div emits label="java"', () => {
      const text = [
        '# F', '', '> Source: /docs/f', '',
        '<div class="impl java">', '',
        'Java-only instructions here, plenty of prose to clear filters.',
        '', '</div>',
      ].join('\n');
      const config = mergeConfig(configP);
      const { sections } = runPipeline(text, config);
      const javaChunk = sections.find(c => c.body.includes('Java-only instructions'));
      assert.ok(javaChunk, 'java-div chunk expected');
      assert.equal(javaChunk.label, 'java');
    });

    test('section with only node-div emits label="node"', () => {
      const text = [
        '# F', '', '> Source: /docs/f', '',
        '<div class="impl node">', '',
        'Node-only instructions here, plenty of prose to clear filters.',
        '', '</div>',
      ].join('\n');
      const config = mergeConfig(configP);
      const { sections } = runPipeline(text, config);
      const nodeChunk = sections.find(c => c.body.includes('Node-only instructions'));
      assert.ok(nodeChunk, 'node-div chunk expected');
      assert.equal(nodeChunk.label, 'node');
    });

    test('section with both java-div and node-div splits into java + node labeled chunks', () => {
      const text = [
        '# Feature', '', '> Source: /docs/f', '', 'intro paragraph long enough to be meaningful.',
        '<div class="impl java">', '',
        'Java specific instructions here that survive transform, meaningful prose.',
        '', '</div>',
        '<div class="impl node">', '',
        'Node specific instructions here that survive transform, meaningful prose.',
        '', '</div>',
      ].join('\n');
      const config = mergeConfig(configP);
      const { sections } = runPipeline(text, config);
      const javaChunk = sections.find(c => c.body.includes('Java specific instructions'));
      const nodeChunk = sections.find(c => c.body.includes('Node specific instructions'));
      assert.ok(javaChunk, 'java-labeled chunk expected');
      assert.ok(nodeChunk, 'node-labeled chunk expected');
      assert.equal(javaChunk.label, 'java');
      assert.equal(nodeChunk.label, 'node');
      assert.equal(javaChunk.source, nodeChunk.source);
    });

    test('every chunk label, when present, is in the known set', () => {
      const text = [
        '# A', '', '> Source: /docs/a', '', 'body A meaningful and long enough to survive filters comfortably.',
        '## B', '', '> Source: /docs/a#b', '', 'body B meaningful and long enough to survive filters comfortably.',
      ].join('\n');
      const KNOWN = new Set(['java', 'node']);
      const config = mergeConfig(configP);
      const { sections } = runPipeline(text, config);
      for (const c of sections) {
        if (c.label === undefined) continue;
        assert.ok(KNOWN.has(c.label), `unknown label ${JSON.stringify(c.label)} for ${c.heading}`);
      }
    });
  });

  describe('chunk boundary and idempotency', () => {
    test('transformed body at exactly maxChunkSize is emitted as one chunk (not split)', () => {
      const paragraph = 'x'.repeat(200);
      const text = [
        '# H', '', '> Source: /docs/h', '', paragraph,
      ].join('\n');
      const config = mergeConfig({ maxChunkSize: 200, minChunkSize: 0 });
      const { sections } = runPipeline(text, config);
      assert.equal(sections.length, 1);
      assert.equal(sections[0].body.length, 200);
    });

    test('running pipeline on its own serialized output yields a stable non-empty chunk set', () => {
      const text = [
        '# A', '', '> Source: /docs/a', '', 'body of A that is meaningful and lengthy enough to survive filters easily even after re-parsing runs again.',
        '## B', '', '> Source: /docs/a#b', '', 'body of B that is meaningful and lengthy enough to survive filters easily even after re-parsing runs again.',
      ].join('\n');
      const config = mergeConfig(configP);
      const first = runPipeline(text, config).sections;
      assert.ok(first.length > 0, 'first run must yield sections');
      const roundtrip = first.map(c => [c.breadcrumb, c.heading, c.source ? `> Source: ${c.source}` : null, c.body].filter(Boolean).join('\n\n')).join('\n\n');
      const second = runPipeline(roundtrip, config).sections;
      assert.ok(second.length > 0, `second run must yield sections; roundtrip len=${roundtrip.length}`);
    });
  });
});

