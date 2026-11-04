import { it, describe, before, mock } from 'node:test'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readInput, embedText } from '../../lib/markdownEmbeddings/createMarkdownEmbeddings.js'
import { runPipeline, stages } from '../../lib/markdownEmbeddings/chunker/pipeline.js'
import { transformBlock as transformFn } from '../../lib/markdownEmbeddings/chunker/stages/05-transform.js'

const INPUT = new URL('../fixtures/embeddings-generation.txt', import.meta.url)
const RAW_TEXT = await readInput(INPUT)

// Mock token measure: a deterministic ~4-chars-per-token approximation of a
// real subword tokenizer, so the injected measure counts tokens (not chars)
// and the maxTokens budgets below are honest token counts.
const mockMeasure = (t) => Math.ceil(t.length / 4)

const CONFIGS = [
  {
    label: 'default config',
    overrides: { maxTokens: 1152, measure: mockMeasure }
  },
  {
    label: 'small chunks (128)',
    overrides: { maxTokens: 128, measure: mockMeasure }
  },
  {
    label: 'large chunks (2048)',
    overrides: { maxTokens: 2048, measure: mockMeasure }
  },
  {
    label: 'maxHeadingDepth=2',
    overrides: { maxTokens: 1152, measure: mockMeasure, maxHeadingDepth: 2 }
  },
  {
    label: 'maxHeadingDepth=1',
    overrides: { maxTokens: 1152, measure: mockMeasure, maxHeadingDepth: 1 }
  }
]

function runE2ESuite(label, configOverrides) {
  describe(`e2e – ${label}`, () => {
    let config
    let outputParse,
      outputSectionize,
      outputMergeSections,
      outputParseBlocks,
      outputTransformBlocks,
      outputPackBlocks,
      outputFilter,
      stageCalls,
      sections

    before(() => {
      config = { maxHeadingDepth: 5, minTokens: 10, ...configOverrides }
      const outputs = {}
      stageCalls = []
      const spies = Object.keys(stages).map((name) => {
        const stage = stages[name]
        return mock.method(stages, name, (...args) => {
          const result = stage(...args)
          // Transformation mutates blocks: snapshot each output before the next stage runs.
          outputs[name] = structuredClone(result)
          stageCalls.push({ name, args, result })
          return result
        })
      })
      try {
        sections = runPipeline(RAW_TEXT, config)
      } finally {
        for (const spy of spies) spy.mock.restore()
      }
      outputParse = outputs.parse
      outputSectionize = outputs.sectionize
      outputMergeSections = outputs.mergeSections
      outputParseBlocks = outputs.parseSectionBlocks
      outputTransformBlocks = outputs.transformSections
      outputPackBlocks = outputs.packSections
      outputFilter = outputs.filter
    })

    function walkNodes(ns, fn) {
      for (const n of ns) {
        fn(n)
        walkNodes(n.children, fn)
      }
    }

    describe('when running all pipeline stages', () => {
      it('should pass stage results in order and return the validated sections directly', () => {
        assert.deepStrictEqual(
          stageCalls.map(({ name }) => name),
          [
            'parse',
            'sectionize',
            'mergeSections',
            'parseSectionBlocks',
            'transformSections',
            'splitSectionsByRuntime',
            'packSections',
            'filter',
            'validate'
          ]
        )
        for (let i = 1; i < stageCalls.length; i++)
          assert.strictEqual(stageCalls[i].args[0], stageCalls[i - 1].result)
        assert.strictEqual(stageCalls[3].args[1], stageCalls[0].result)
        assert.ok(Array.isArray(sections))
        assert.strictEqual(sections, stageCalls.at(-1).result)
      })

      describe('given stage 01-parse', () => {
        it('should give every parsed node a non-empty source', () => {
          walkNodes(outputParse, (n) =>
            assert.ok(n.source.length > 0, `node missing source: ${n.title}`)
          )
        })

        it('should exclude the source line from every node body', () => {
          walkNodes(outputParse, (n) => {
            if (n.source)
              assert.ok(!n.body.includes(n.source), `source leaked into body: ${n.title}`)
          })
        })

        it('should trim leading blank lines from every node body', () => {
          walkNodes(outputParse, (n) =>
            assert.ok(!n.body.startsWith('\n'), `body starts with blank line: ${n.title}`)
          )
        })

        it('should not create a node for a heading inside an unclosed outer container', () => {
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
          ]
          const foundSources = new Set()
          walkNodes(outputParse, (n) => {
            if (n.source) foundSources.add(n.source.replace(/^>\s*Source:\s*/, '').trim())
          })
          for (const src of knownBadSources) {
            assert.ok(
              !foundSources.has(src),
              `heading inside unclosed outer container was parsed as a separate node: ${src}`
            )
          }
        })

        it('should collect headings beyond maxHeadingDepth (no depth gate in parse stage)', () => {
          let maxDepth = 0
          walkNodes(outputParse, (n) => {
            if (n.depth > maxDepth) maxDepth = n.depth
          })
          assert.ok(
            maxDepth > config.maxHeadingDepth,
            `expected nodes deeper than ${config.maxHeadingDepth} but max depth was ${maxDepth}`
          )
        })
      })

      describe('given stage 02-section', () => {
        it('should fold deep sections that exceed maxHeadingDepth instead of emitting them', () => {
          for (const s of outputSectionize) {
            const depth = /^(#+) /.exec(s.heading)?.[1].length ?? 0
            assert.ok(
              depth <= config.maxHeadingDepth,
              `section heading depth ${depth} exceeds maxHeadingDepth: ${s.heading}`
            )
          }
        })

        it('should give every section a non-empty source', () => {
          for (const s of outputSectionize) {
            assert.ok(s.source.length > 0, `section missing source: ${s.heading}`)
          }
        })

        it('should emit sections in DFS order (parent headingPath is prefix of child)', () => {
          for (let i = 1; i < outputSectionize.length; i++) {
            const prev = outputSectionize[i - 1].headingPath
            const curr = outputSectionize[i].headingPath
            if (curr.length > prev.length) {
              assert.deepStrictEqual(
                curr.slice(0, prev.length),
                prev,
                `section out of DFS order at index ${i}: ${JSON.stringify(curr)}`
              )
            }
          }
        })

        it("should set the heading field to the node's raw heading line", () => {
          // heading is set from node.raw — must start with # and match depth field
          for (const s of outputSectionize) {
            assert.match(s.heading, /^#{1,6} /, `heading not a raw heading line: ${s.heading}`)
            const depth = /^(#+) /.exec(s.heading)[1].length
            assert.strictEqual(depth, s.depth, `heading depth mismatch for: ${s.heading}`)
          }
        })

        it('should set the headingPath last element to match the heading title', () => {
          for (const s of outputSectionize) {
            if (s.headingPath.length === 0) continue
            const title = s.heading.replace(/^#+\s+/, '').trim()
            assert.strictEqual(
              s.headingPath[s.headingPath.length - 1],
              title,
              `headingPath tail mismatch for: ${s.heading}`
            )
          }
        })

        it('should emit no more sections than nodes (folded nodes excluded)', () => {
          let nodeCount = 0
          walkNodes(outputParse, () => nodeCount++)
          assert.ok(
            outputSectionize.length <= nodeCount,
            `sections (${outputSectionize.length}) exceed nodes (${nodeCount})`
          )
        })

        it('should emit fewer sections than nodes when the doc has nodes beyond maxHeadingDepth', () => {
          let deepCount = 0
          walkNodes(outputParse, (n) => {
            if (n.depth > config.maxHeadingDepth) deepCount++
          })
          if (deepCount > 0) {
            let nodeCount = 0
            walkNodes(outputParse, () => nodeCount++)
            assert.ok(
              outputSectionize.length < nodeCount,
              `expected fewer sections than nodes when ${deepCount} nodes are folded`
            )
          }
        })
      })

      describe('given stage 03-merge', () => {
        it('should never add sections during merge', () => {
          assert.ok(outputMergeSections.length <= outputSectionize.length)
        })

        it('should give every merged section non-empty source, headingPath, and heading', () => {
          for (const s of outputMergeSections) {
            assert.ok(s.source.length > 0, `missing source: ${s.heading}`)
            assert.ok(s.headingPath.length > 0, `missing headingPath: ${s.heading}`)
            assert.ok(s.heading.length > 0, 'missing heading')
          }
        })

        it('should set merged section depth to match the heading marker depth', () => {
          for (const s of outputMergeSections) {
            const depth = /^(#+) /.exec(s.heading)?.[1].length ?? 0
            assert.strictEqual(depth, s.depth, `depth mismatch: ${s.heading}`)
          }
        })

        it('should merge an empty-body section with the next non-empty section at the same depth', () => {
          for (let i = 0; i < outputMergeSections.length - 1; i++) {
            const curr = outputMergeSections[i]
            const next = outputMergeSections[i + 1]
            if (curr.body.trim() !== '') continue
            if (next.body.trim() === '') continue // two consecutive empties are fine
            assert.ok(
              next.depth !== curr.depth,
              `empty section "${curr.heading}" still followed by non-empty same-depth section "${next.heading}" — should have been merged`
            )
          }
        })

        it('should match outputMergeSections count to sections minus empty-body absorptions when mergeLeadIn is disabled', () => {
          // Simulate general empty-body absorption rule in 03-merge.js exactly.
          // All consecutive empty-body sections at same depth as the next non-empty are absorbed.
          let expected = outputSectionize.length
          let i = 0
          while (i < outputSectionize.length) {
            const curr = outputSectionize[i]
            if (curr.body.trim() === '') {
              let j = i + 1
              while (
                j < outputSectionize.length &&
                outputSectionize[j].depth === curr.depth &&
                outputSectionize[j].body.trim() === ''
              )
                j++
              const target = outputSectionize[j]
              if (target && target.depth === curr.depth) {
                // count how many preceding empty-body sections at same depth get absorbed from result
                let k = i - 1
                while (
                  k >= 0 &&
                  outputSectionize[k].depth === curr.depth &&
                  outputSectionize[k].body.trim() === ''
                )
                  k--
                // absorbed: empties from k+1..i plus empties i+1..j-1 — all collapse into target
                expected -= j - k - 1 // (j-1) - (k+1) + 1 empties absorbed = j - k - 1
                i = j + 1
                continue
              }
            }
            i++
          }
          assert.strictEqual(
            outputMergeSections.length,
            expected,
            `outputMergeSections (${outputMergeSections.length}) !== expected (${expected}) — empty-body absorption simulation is off`
          )
        })
      })

      describe('given stage 04-parse-blocks', () => {
        const VALID_TYPES = new Set([
          'fence',
          'container',
          'html-table',
          'java-div',
          'node-div',
          'cols-div',
          'md-table',
          'list',
          'list-item',
          'admonition',
          'bullet-item',
          'redirect',
          'paragraph',
          'heading'
        ])
        const blocks = () => outputParseBlocks.flatMap(({ blocks: bs }) => bs)
        const STRUCTURAL = new Set([
          'container',
          'java-div',
          'node-div',
          'cols-div',
          'list',
          'list-item',
          'bullet-item'
        ])
        function flat(bs) {
          const o = []
          for (const b of bs) {
            o.push(b)
            if (b.parts && STRUCTURAL.has(b.type)) o.push(...flat(b.parts))
          }
          return o
        }
        const ofType = (t) => flat(blocks()).filter((b) => b.type === t)

        it('should produce at least one block for every section', () => {
          for (const { section, blocks: bs } of outputParseBlocks)
            assert.ok(bs.length > 0, `no blocks for: ${section.heading}`)
        })

        it('should assign only known types to all blocks including parts[]', () => {
          for (const b of flat(blocks()))
            assert.ok(VALID_TYPES.has(b.type), `unknown block type: ${b.type}`)
        })

        it('should mark fence blocks with supressCut=true and opener starting with ` or ~', () => {
          const fences = ofType('fence')
          assert.ok(fences.length > 0, 'no fence blocks')
          for (const b of fences) {
            assert.match(b.text, /^\s*[`~]/, 'fence must start with `, ~ or indent')
            assert.strictEqual(b.supressCut, true)
          }
        })

        it('should mark container blocks with parts[] and supressCut=true', () => {
          const containers = ofType('container')
          assert.ok(containers.length > 0, 'no container blocks')
          for (const b of containers) {
            if (b.opener)
              assert.ok(
                !b.opener.includes('code-group'),
                'container opener does not contain code-group'
              )
            assert.ok(Array.isArray(b.parts))
            assert.strictEqual(b.supressCut, true)
          }
        })

        it('should mark html-table blocks with supressCut=true and text containing <table', () => {
          const tables = ofType('html-table')
          assert.ok(tables.length > 0, 'no html-table blocks')
          for (const b of tables) {
            assert.match(b.text, /<table/i)
            assert.strictEqual(b.supressCut, true)
          }
        })

        it('should mark java-div blocks with parts[] and supressCut=false', () => {
          const divs = ofType('java-div')
          assert.ok(divs.length > 0, 'no java-div blocks')
          for (const b of divs) {
            assert.match(b.opener, /java/i)
            assert.ok(Array.isArray(b.parts))
            assert.strictEqual(b.supressCut, false)
          }
        })

        it('should mark node-div blocks with parts[] and supressCut=false', () => {
          const divs = ofType('node-div')
          assert.ok(divs.length > 0, 'no node-div blocks')
          for (const b of divs) {
            assert.match(b.opener, /node/i)
            assert.ok(Array.isArray(b.parts))
            assert.strictEqual(b.supressCut, false)
          }
        })

        it('should mark cols-div blocks with parts[] and supressCut=false', () => {
          const divs = ofType('cols-div')
          assert.ok(divs.length > 0, 'no cols-div blocks')
          for (const b of divs) {
            assert.strictEqual(b.opener, undefined)
            assert.ok(Array.isArray(b.parts))
            assert.strictEqual(b.supressCut, false)
          }
        })

        it('should mark md-table blocks with supressCut=true and text starting with |', () => {
          const tables = ofType('md-table')
          assert.ok(tables.length > 0, 'no md-table blocks')
          for (const b of tables) {
            assert.match(b.text, /^\s*\|/)
            assert.strictEqual(b.supressCut, true)
          }
        })

        it('should mark list-item blocks with parts[] and opener matching N. pattern', () => {
          const items = ofType('list-item')
          assert.ok(items.length > 0, 'no list-item blocks')
          for (const b of items) {
            assert.match(b.opener ?? b.text ?? '', /^\d+\.\s/)
            assert.ok(Array.isArray(b.parts))
            assert.strictEqual(b.supressCut, false)
          }
        })

        it('should mark admonition blocks as splittable with text starting with > [!TYPE]', () => {
          const admons = ofType('admonition')
          assert.ok(admons.length > 0, 'no admonition blocks')
          for (const b of admons) {
            if (!b.text) continue // admonition with parts may not have text set
            assert.match(b.text, /^>\s*\[!(tip|note|warning|important|info|danger|caution)\]/i)
            assert.strictEqual(b.atomic, undefined)
          }
        })

        it('should mark bullet-item blocks with parts[] and opener matching bullet pattern', () => {
          const items = ofType('bullet-item')
          assert.ok(items.length > 0, 'no bullet-item blocks')
          for (const b of items) {
            assert.match(b.opener ?? b.text ?? '', /^\s*[-*+]\s/)
            assert.ok(Array.isArray(b.parts))
            assert.strictEqual(b.supressCut, false)
          }
        })

        it('should mark redirect blocks with supressCut=true and text ending with {.learn-more}', () => {
          const redirects = ofType('redirect')
          assert.ok(redirects.length > 0, 'no redirect blocks')
          for (const b of redirects) {
            assert.match(b.text, /\{\s*\.?\s*learn-more\}\s*$/)
            assert.strictEqual(b.supressCut, true)
          }
        })

        it('should mark paragraph blocks with isLeadIn and isAnaphoric booleans and supressCut=false', () => {
          const paras = ofType('paragraph')
          assert.ok(paras.length > 0, 'no paragraph blocks')
          for (const b of paras) {
            assert.ok(typeof b.isLeadIn === 'boolean', 'paragraph missing isLeadIn')
            assert.ok(typeof b.isAnaphoric === 'boolean', 'paragraph missing isAnaphoric')
            assert.strictEqual(b.supressCut, false)
          }
        })

        it('should flag at least one paragraph as isLeadIn=true', () => {
          assert.ok(
            ofType('paragraph').some((b) => b.isLeadIn),
            'no isLeadIn paragraph found'
          )
        })

        it('should flag at least one paragraph as isAnaphoric=true', () => {
          assert.ok(
            ofType('paragraph').some((b) => b.isAnaphoric),
            'no isAnaphoric paragraph found'
          )
        })

        it('should parse a fence inside a blockquote-prefixed code-group admonition as a fence block (not paragraph)', () => {
          // Real corpus: /docs/guides/databases/hana#undeploying-artifacts —
          //   > [!danger] Never undeploy hdbtable files
          //   > ::: code-group
          //   > ```json [db/undeploy.json]
          //   >   "src/...hdbtable" // [!code error] data loss!
          //   > ```
          //   > :::
          const hanaEntry = outputParseBlocks.find(({ blocks: bs }) =>
            bs.some((b) => b.type === 'admonition' && (b.opener || '').includes('Never undeploy'))
          )
          assert.ok(
            hanaEntry,
            'admonition "Never undeploy hdbtable files" not found in tokenize output'
          )
          const admon = hanaEntry.blocks.find(
            (b) => b.type === 'admonition' && (b.opener || '').includes('Never undeploy')
          )
          const innerContainer = admon.parts?.find((p) => p.type === 'container')
          assert.ok(
            innerContainer,
            'inner ::: code-group must be parsed as a container part inside the admonition'
          )
          const fencePart = innerContainer.parts?.find((p) => p.type === 'fence')
          assert.ok(
            fencePart,
            `blockquote-prefixed fence must be a fence block inside the container, got: ${JSON.stringify(innerContainer.parts?.map((p) => p.type))}`
          )
        })
      })

      describe('given stage 05-transform', () => {
        const blocks = () => outputTransformBlocks.flatMap(({ blocks: bs }) => bs)
        function flatDeep(bs) {
          const out = []
          for (const b of bs) {
            out.push(b)
            if (b.parts?.length) out.push(...flatDeep(b.parts))
          }
          return out
        }
        const allBlocks = () => flatDeep(blocks())
        const ofType = (t) => allBlocks().filter((b) => b.type === t)

        it('should strip :::code-group from every block text', () => {
          for (const b of allBlocks()) {
            const text = b.text ?? b.opener ?? ''
            assert.ok(
              !text.includes('code-group'),
              `block type="${b.type}" contains ::: code-group: ${text}`
            )
          }
        })

        // ── existence ────────────────────────────────────────────────────────────
        it('should drop every block marked isEmpty=true', () => {
          for (const { blocks: bs } of outputTransformBlocks)
            for (const b of bs) assert.ok(!b.isEmpty, 'isEmpty block survived filter')
        })

        it('should not increase the block count relative to the tokenize stage', () => {
          const before = outputParseBlocks.reduce((s, { blocks: bs }) => s + bs.length, 0)
          const after = outputTransformBlocks.reduce((s, { blocks: bs }) => s + bs.length, 0)
          assert.ok(after <= before)
        })

        // ── shared normalization ─────────────────────────────────────────────────
        it('should collapse 3+ consecutive blank lines to 2 in every block text', () => {
          // Rule: shared normalization collapses \n{3,} → \n\n for all non-fence types.
          // Fences and containers preserve inner content verbatim, so skip those.
          const VERBATIM = new Set([
            'fence',
            'container',
            'java-div',
            'node-div',
            'cols-div',
            'list-item',
            'bullet-item'
          ])
          for (const b of allBlocks()) {
            if (VERBATIM.has(b.type)) continue
            assert.ok(
              !/\n{3,}/.test(b.text),
              `3+ blank lines in ${b.type}: ${JSON.stringify(b.text.slice(0, 80))}`
            )
          }
        })

        it('should normalize CRLF line endings to LF in every block text', () => {
          for (const b of allBlocks())
            assert.ok(
              !b.text.includes('\r'),
              `CRLF survived in ${b.type}: ${JSON.stringify(b.text.slice(0, 60))}`
            )
        })

        it('should trim leading and trailing whitespace from every block text', () => {
          // bullet-item and list-item preserve indentation so leading space is expected there.
          // java-div with empty inner content can produce "Java:\n" (trailing newline) — known gap.
          // paragraph with only a link can produce leading/trailing newline — known gap.
          const SKIP = new Set(['bullet-item', 'list-item', 'java-div', 'node-div', 'paragraph'])
          for (const b of allBlocks()) {
            if (SKIP.has(b.type)) continue
            assert.strictEqual(
              b.text,
              b.text.trim(),
              `untrimmed ${b.type}: ${JSON.stringify(b.text.slice(0, 80))}`
            )
          }
        })

        it('should strip attribute-bearing HTML tags from every block', () => {
          const SKIP = new Set(['container', 'fence'])
          for (const b of allBlocks()) {
            if (SKIP.has(b.type)) continue
            const hasHTML =
              b.text.includes('<span ') || b.text.includes('<div ') || b.text.includes('<br>')
            assert.ok(!hasHTML, `${b.type} includes html \n${b.text}`)
          }
        })

        // ── paragraph rules ──────────────────────────────────────────────────────
        it('should collapse multi-space runs outside backtick spans in paragraph blocks', () => {
          // Rule: collapse 2+ spaces → 1 space, but not inside `...`.
          for (const b of ofType('paragraph')) {
            const parts = b.text.split('`')
            for (let i = 0; i < parts.length; i += 2) {
              // even indices = outside backticks
              assert.ok(
                !/ {2,}/.test(parts[i]),
                `multi-space outside backticks in paragraph: ${JSON.stringify(b.text.slice(0, 100))}`
              )
            }
          }
        })

        it('should strip [!code --] markers from paragraph blocks', () => {
          for (const b of ofType('paragraph')) {
            assert.ok(!b.text.includes('code --'))
          }
        })

        it('should strip {.class} and {#id} markers from paragraph blocks', () => {
          for (const b of ofType('paragraph')) {
            const parts = b.text.split('`')
            for (let i = 0; i < parts.length; i += 2) {
              // outside backticks only
              assert.ok(
                !/\{\s*[.#][^}]*\}/.test(parts[i]),
                `class/id marker survived in paragraph: ${JSON.stringify(b.text.slice(0, 100))}`
              )
            }
          }
        })

        it('should strip or replace raw image syntax ![]() in paragraph blocks', () => {
          // Exception: ![`...`] is escaped identifier syntax in CDS/CDL, not an image.
          for (const b of ofType('paragraph')) {
            const text = b.text
            // strip backtick spans first so we don't flag ![`id`] inside code
            const noCode = text.replace(/`[^`\n]+`/g, '``')
            assert.ok(
              !/!\[/.test(noCode),
              `image syntax survived in paragraph: ${JSON.stringify(text.slice(0, 100))}`
            )
          }
        })

        it('should strip the <UnderConstruction/> tag from paragraph blocks', () => {
          for (const b of ofType('paragraph'))
            assert.ok(
              !/<UnderConstruction/i.test(b.text),
              `<UnderConstruction/> survived in paragraph: ${JSON.stringify(b.text.slice(0, 100))}`
            )
        })

        it('should resolve relative markdown links in paragraph blocks to absolute paths', () => {
          // After transform, links are 'label (url)'. Relative paths (../ or ./) must not survive.
          for (const b of ofType('paragraph')) {
            for (const [, url] of b.text.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
              assert.fail(
                `unresolved relative link in paragraph: ${JSON.stringify(url)} in: ${b.text.slice(0, 80)}`
              )
            }
          }
        })

        // ── redirect rules (same pipeline as paragraph) ──────────────────────────
        it('should strip the {.learn-more} marker from redirect blocks', () => {
          for (const b of ofType('redirect'))
            assert.ok(
              !/\{\.learn-more\}/.test(b.text),
              `{.learn-more} survived in redirect: ${JSON.stringify(b.text.slice(0, 100))}`
            )
        })

        it('should resolve relative markdown links in redirect blocks to absolute paths', () => {
          for (const b of ofType('redirect')) {
            for (const [, url] of b.text.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
              assert.fail(`unresolved relative link in redirect: ${JSON.stringify(url)}`)
            }
          }
        })

        // ── fence rules ──────────────────────────────────────────────────────────
        it('should preserve the fence opener so block text starts with ``` or ~~~', () => {
          for (const b of ofType('fence')) {
            const body = b.text.replace(/^(Java:|Node\.js:)\n/, '')
            assert.ok(
              body.startsWith('`') || body.startsWith('~'),
              `fence opener malformed: ${JSON.stringify(b.text.slice(0, 40))}`
            )
          }
        })

        it('should preserve the fence closer so block text ends with ``` or ~~~', () => {
          for (const b of ofType('fence')) {
            const lastLine = (b.text.split('\n').at(-1) ?? '').trim()
            assert.ok(
              /^(`{3,}|~{3,})/.test(lastLine),
              `fence closer malformed: ${JSON.stringify(b.text.slice(-40))}`
            )
          }
        })

        // ── bullet-list / list rules ─────────────────────────────────────────────
        it('should strip {.class} markers outside backtick spans from bullet-item blocks', () => {
          for (const b of ofType('bullet-item')) {
            const parts = b.text.split('`')
            for (let i = 0; i < parts.length; i += 2)
              assert.ok(
                !/\{\s*[.#][^}]*\}/.test(parts[i]),
                `class marker survived in bullet-item: ${JSON.stringify(b.text.slice(0, 100))}`
              )
          }
        })

        it('should strip {.class} markers outside backtick spans from list-item blocks', () => {
          for (const b of ofType('list-item')) {
            const parts = b.text.split('`')
            for (let i = 0; i < parts.length; i += 2)
              assert.ok(
                !/\{\s*[.#][^}]*\}/.test(parts[i]),
                `class marker survived in list-item: ${JSON.stringify(b.text.slice(0, 100))}`
              )
          }
        })

        // ── md-table rules ───────────────────────────────────────────────────────
        it('should collapse long dash runs to a single-dash separator in md-table rows', () => {
          // Rule: compactTableCells collapses -{2,} → - in separator rows.
          for (const b of ofType('md-table')) {
            for (const line of b.text.split('\n')) {
              if (/^\s*\|[\s\-:|]+\|?\s*$/.test(line)) {
                assert.ok(
                  !/-{2,}/.test(line),
                  `long dash run in md-table separator: ${JSON.stringify(line)}`
                )
              }
            }
          }
        })

        it('should decode raw HTML entities in md-table block text', () => {
          for (const { section, blocks: bs } of outputTransformBlocks) {
            for (const b of bs) {
              if (b.type !== 'md-table') continue
              assert.ok(
                !/&[a-zA-Z]+;|&#\d+;/.test(b.text),
                `raw HTML entity survived in md-table: ${JSON.stringify(b.text.slice(0, 100))} (section: ${section.source})`
              )
            }
          }
        })

        it('should resolve relative markdown links in md-table blocks to absolute paths', () => {
          for (const b of ofType('md-table')) {
            for (const [, url] of b.text.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
              assert.fail(`unresolved relative link in md-table: ${JSON.stringify(url)}`)
            }
          }
        })

        // ── html-table rules ─────────────────────────────────────────────────────
        it('should strip the <table> wrapper tag from html-table block text', () => {
          for (const b of ofType('html-table'))
            assert.ok(
              !/<table/i.test(b.text),
              `<table> tag survived in html-table: ${JSON.stringify(b.text.slice(0, 80))}`
            )
        })

        it('should strip raw <td> and <th> tags from html-table block text', () => {
          for (const b of ofType('html-table'))
            assert.ok(
              !/<t[dh]/i.test(b.text),
              `<td>/<th> tag survived in html-table: ${JSON.stringify(b.text.slice(0, 80))}`
            )
        })

        it('should decode raw HTML entities in html-table block text', () => {
          for (const b of ofType('html-table'))
            assert.ok(
              !/&[a-zA-Z]+;|&#\d+;/.test(b.text),
              `raw HTML entity survived in html-table: ${JSON.stringify(b.text.slice(0, 100))}`
            )
        })

        it('should resolve relative links in html-table blocks to absolute paths', () => {
          for (const b of ofType('html-table')) {
            for (const [, url] of b.text.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
              assert.fail(`unresolved relative link in html-table: ${JSON.stringify(url)}`)
            }
          }
        })

        // ── java-div / node-div rules ─────────────────────────────────────────────
        it('should prefix every java-div block with the Java: label', () => {
          for (const b of ofType('java-div'))
            assert.ok(
              b.text.startsWith('Java:'),
              `java-div missing label: ${JSON.stringify(b.text.slice(0, 60))}`
            )
        })

        it('should prefix every node-div block with the Node.js: label', () => {
          for (const b of ofType('node-div'))
            assert.ok(
              b.text.startsWith('Node.js:'),
              `node-div missing label: ${JSON.stringify(b.text.slice(0, 60))}`
            )
        })

        it('should strip the outer <div> tag from java-div block text', () => {
          for (const b of ofType('java-div'))
            assert.ok(
              !/<div/i.test(b.text),
              `<div> tag survived in java-div: ${JSON.stringify(b.text.slice(0, 80))}`
            )
        })

        it('should strip the outer <div> tag from node-div block text', () => {
          for (const b of ofType('node-div'))
            assert.ok(
              !/<div/i.test(b.text),
              `<div> tag survived in node-div: ${JSON.stringify(b.text.slice(0, 80))}`
            )
        })

        it('should resolve relative links in java-div blocks to absolute paths', () => {
          for (const b of ofType('java-div')) {
            for (const [, url] of b.text.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
              assert.fail(`unresolved relative link in java-div: ${JSON.stringify(url)}`)
            }
          }
        })

        // ── container rules ──────────────────────────────────────────────────────
        it('should strip ::: delimiters from container block text', () => {
          // The outer ::: opener and closer are stripped; only inner part text remains.
          // Nested ::: blocks can appear verbatim when deep sections are folded into a
          // parent container, so we only assert the outer wrapper is gone:
          // the first line must not be the opener (:::...) and the last line must not be :::.
          for (const b of ofType('container')) {
            const lines = b.text.split('\n').filter((l) => l.trim())
            if (!lines.length) continue
            if (lines[0].includes('code-group')) {
              assert.ok(
                !/^:::\s*$/.test(lines[0]),
                `container text starts with bare ::: opener: ${JSON.stringify(b.text.slice(0, 80))}`
              )
              assert.ok(
                !/^:::\s*$/.test(lines[lines.length - 1]),
                `container text ends with ::: closer: ${JSON.stringify(b.text.slice(-80))}`
              )
            }
          }
        })

        // ── admonition rules ─────────────────────────────────────────────────────
        it('should preserve the > [!TYPE] marker so admonition block text starts with it', () => {
          for (const b of ofType('admonition')) {
            const body = b.text.replace(/^(Java:|Node\.js:)\n/, '')
            assert.match(
              body,
              /^>\s*\[!(tip|note|warning|important|info|danger|caution)\]/i,
              `admonition [!TYPE] marker missing: ${JSON.stringify(b.text.slice(0, 60))}`
            )
          }
        })

        // ── cols-div rules ───────────────────────────────────────────────────────
        it('should strip the outer <div> tag from cols-div block text', () => {
          for (const b of ofType('cols-div'))
            assert.ok(
              !/<div/i.test(b.text),
              `<div> tag survived in cols-div: ${JSON.stringify(b.text.slice(0, 80))}`
            )
        })

        // ── container opener link resolution ─────────────────────────────────────
        it('should resolve relative links in the container opener (../../ paths)', () => {
          // Bug: container transform emits block.opener.trim() verbatim without calling
          // resolveLinks, so "::: details ... [text](../../path#anchor) ..." links are
          // never resolved. Example in corpus: /docs/guides/domain/#cdsoninsert has
          // "::: details Note the differences to [defaults](../../cds/cdl#default-values)..."
          for (const { section, blocks: bs } of outputTransformBlocks) {
            for (const b of bs) {
              if (b.type !== 'container') continue
              const opener = b.opener ?? ''
              for (const [, url] of opener.matchAll(/\((\.\.\/[^)]+|\.\/[^)]+)\)/g)) {
                assert.fail(
                  `unresolved relative link in container opener: ${JSON.stringify(url)} in opener: ${JSON.stringify(opener.slice(0, 100))} (section: ${section.source})`
                )
              }
            }
          }
        })

        // ── HTML stub lines with attributes not stripped ──────────────────────────
        it('should strip bare block-level HTML tags with attributes from paragraph blocks (e.g. <span class="...">)', () => {
          // Bug: isHtmlStub uses HTML_STUB = /^<[A-Za-z][^>]*\/>\s*$|^<[a-z]+>\s*$|^<\/[a-z]+>\s*$/
          // which only matches tags without attributes. Lines like "<span class=\"small\">"
          // on their own line pass through normalizeShared unfiltered into paragraph text.
          // Example in corpus: /docs/get-started/bookshop#compile-to-sql has a
          // "<span class=\"small\">" line wrapping a code block.
          const BLOCK_HTML_WITH_ATTRS = /^<[a-z][a-z0-9]*(?:\s+[^>]*)?>$/im
          for (const { section, blocks: bs } of outputTransformBlocks) {
            for (const b of bs) {
              if (b.type !== 'paragraph') continue
              for (const line of b.text.split('\n')) {
                const trimmed = line.trim()
                if (!trimmed) continue
                assert.ok(
                  !BLOCK_HTML_WITH_ATTRS.test(trimmed),
                  `bare HTML open tag with attributes survived in paragraph: ${JSON.stringify(trimmed)} (section: ${section.source})`
                )
              }
            }
          }
        })

        // ── idempotency ──────────────────────────────────────────────────────────
        it('should produce the same result when re-run on already-transformed text (idempotent)', () => {
          // Container/div types store transformed text in b.text but the opener/parts[] are
          // needed to re-transform — without them fallbackParts re-tokenizes the already-stripped
          // inner text, which can differ. Only test atomic block types here.
          const ATOMIC = new Set(['paragraph', 'fence', 'md-table', 'html-table', 'redirect'])
          let checked = 0
          for (const b of allBlocks()) {
            if (!ATOMIC.has(b.type)) continue
            if (checked >= 300) break
            if (!b.text || b.text.trim() === '') continue
            const b2 = { type: b.type, text: b.text, supressCut: b.supressCut }
            const second = transformFn(b2, b.source)
            assert.strictEqual(
              second,
              b.text,
              `transform not idempotent for ${b.type}: first=${JSON.stringify(b.text.slice(0, 60))} second=${JSON.stringify(second.slice(0, 60))}`
            )
            checked++
          }
        })

        it('should strip a trailing newline from paragraph blocks (stripped image leaves orphan \\n)', () => {
          for (const b of ofType('paragraph')) {
            assert.ok(
              !b.text.endsWith('\n'),
              `paragraph ends with trailing \\n: ${JSON.stringify(b.text.slice(-60))}`
            )
          }
        })

        it('should decode raw HTML entities in every block text', () => {
          const ENTITY_RE = /&(?:amp|lt|gt|quot|nbsp|ndash|mdash|#\d+);/
          for (const b of allBlocks()) {
            if (b.type === 'fence' || b.type === 'container') continue
            assert.ok(
              !ENTITY_RE.test(b.text ?? ''),
              `raw HTML entity in ${b.type} block: ${JSON.stringify((b.text ?? '').slice(0, 100))}`
            )
          }
        })

        it('should strip images from every block text', () => {
          for (const b of allBlocks()) {
            if (b.type === 'fence' || b.type === 'container') continue
            const hasLink =
              b.text.includes('.svg') ||
              b.text.includes('/logos') ||
              b.text.includes('<img') ||
              b.text.includes('.png')
            assert.ok(!hasLink, `${b.type} includes image \n${b.text}`)
          }
        })

        it('should strip {.class} and {#id} markers from heading and redirect blocks', () => {
          for (const b of allBlocks()) {
            if (b.type !== 'heading' && b.type !== 'redirect') continue
            const parts = b.text.split('`')
            for (let i = 0; i < parts.length; i += 2) {
              assert.ok(
                !/\{\s*[.#][^}]*\}/.test(parts[i]),
                `class/id marker survived in ${b.type}: ${JSON.stringify(b.text.slice(0, 100))}`
              )
            }
          }
        })

        it('should decode raw HTML entities in heading and redirect blocks', () => {
          const ENTITY_RE = /&(?:amp|lt|gt|quot|nbsp|ndash|mdash|rarr|#\d+);/
          for (const b of allBlocks()) {
            if (b.type !== 'heading' && b.type !== 'redirect') continue
            assert.ok(
              !ENTITY_RE.test(b.text ?? ''),
              `raw HTML entity in ${b.type}: ${JSON.stringify(b.text.slice(0, 100))}`
            )
          }
        })

        it('should compact long dash runs to a single - in md-table separator rows', () => {
          for (const b of ofType('md-table')) {
            for (const line of b.text.split('\n')) {
              const trimmed = line.trimStart()
              if (!/^\|[\s\-:|]+\|?\s*$/.test(trimmed)) continue
              assert.ok(
                !/-{2,}/.test(trimmed),
                `long dash run in md-table separator: ${JSON.stringify(line)}`
              )
            }
          }
        })

        it('should keep hrefs rather than drop them as link-only', () => {
          const hasFixture = allBlocks().some((b) =>
            b.text.includes('/docs/java/multitenancy#db-connection-pooling')
          )
          assert.ok(hasFixture)
        })

        it('should keep <a> tags in tables', () => {
          const hasFixture = allBlocks().some((b) => b.text.includes('<a valid Maven groupId>'))
          assert.ok(hasFixture)
        })

        // ── real-world section regression ─────────────────────────────────────────
        it('should preserve both the Node.js and Java badge links in the ## AI plugin section (llms-full.txt line 83097)', () => {
          // Real pattern: two adjacent badge image-in-links on separate lines, one paragraph block:
          //   [![Node.js](/logos/nodejs.svg){}](https://github.com/cap-js/ai)
          //   [![Java](/logos/java.svg){}](https://github.com/cap-java/cds-ai)
          // Bug: isFilenameAlt('Java', '/logos/java.svg') returns true (pure alnum alt, url
          // contains alt lowercased) → inner image stripped to '' → outer [](...) link dropped.
          // The Java link silently disappears from the transformed output.
          // ## AI is a depth-2 section — not present when maxHeadingDepth=1 folds it away.
          const aiSection = outputTransformBlocks.find(
            ({ section }) => section.source && section.source.includes('/docs/plugins/#ai')
          )
          if (!aiSection) return // folded at maxHeadingDepth=1 — skip
          const combined = aiSection.blocks.map((b) => b.text).join('\n\n')
          assert.ok(
            combined.includes('Node.js (https://github.com/cap-js/ai)'),
            `Node.js badge link lost in ## AI section. Combined text tail: ${JSON.stringify(combined.slice(-300))}`
          )
          assert.ok(
            combined.includes('Java (https://github.com/cap-java/cds-ai)'),
            `Java badge link lost in ## AI section. Combined text tail: ${JSON.stringify(combined.slice(-300))}`
          )
        })
      })

      describe('given stage 07-packBlocks', () => {
        it('should produce at least one bodyPart for every section', () => {
          for (const { section } of outputTransformBlocks)
            assert.ok(
              outputPackBlocks.some(
                (chunk) => chunk.source === `https://cap.cloud.sap${section.source}`
              ),
              `no bodyParts for: ${section.heading}`
            )
        })

        it('should leave no bodyPart with an unclosed code fence', () => {
          for (const { embeddingBody: p } of outputPackBlocks) {
            const count = (p.match(/```/g) || []).length
            assert.strictEqual(count % 2, 0, 'odd fence count in bodyPart')
          }
        })

        it('should leave no bodyPart empty after trim', () => {
          for (const { embeddingBody: p } of outputPackBlocks)
            assert.ok(p.trim().length > 0, 'empty bodyPart emitted')
        })

        it('should leave every bodyPart equal to its own trim (no leading/trailing whitespace)', () => {
          for (const { embeddingBody: p } of outputPackBlocks)
            assert.strictEqual(
              p,
              p.trim(),
              `bodyPart not trimmed: ${JSON.stringify(p.slice(0, 60))}`
            )
        })

        it('should produce no rendered embedding text that exceeds maxTokens', () => {
          assert.ok(outputPackBlocks.length > 0)
          for (const chunk of outputPackBlocks) {
            const text = embedText(chunk)
            assert.ok(
              config.measure(text) <= config.maxTokens,
              `embedding text exceeds maxTokens (${config.measure(text)} > ${config.maxTokens}) in section "${chunk.heading}": ${JSON.stringify(text.slice(0, 120))}`
            )
          }
        })
      })

      describe('given stage 08-filter', () => {
        it('should not end any section on a heading', () => {
          for (const { displayBody, heading } of outputFilter) {
            const lastNonEmpty =
              displayBody
                .split('\n')
                .filter((l) => l.trim() !== '')
                .at(-1) ?? ''
            assert.ok(
              !/^\s*#{1,6} \S/.test(lastNonEmpty),
              `${JSON.stringify(configOverrides)}: bodyPart ends on a heading in section: ${heading}\n${displayBody}`
            )
          }
        })

        it('should only remove chunks during filter, never add', () => {
          const beforeCount = outputPackBlocks.length
          assert.ok(outputFilter.length <= beforeCount)
        })

        it('should give every filtered chunk a non-empty breadcrumb, heading, and body', () => {
          for (const c of outputFilter) {
            assert.ok(c.breadcrumb.length > 0, 'breadcrumb empty')
            assert.ok(c.heading.length > 0, 'heading empty')
            assert.ok(c.displayBody.trim().length > 0, 'body empty')
          }
        })

        it('should give every filtered chunk a valid label when present (java|node), else none', () => {
          const KNOWN = new Set(['java', 'node'])
          for (const c of outputFilter) {
            if (c.label === undefined) continue
            assert.ok(
              KNOWN.has(c.label),
              `invalid label ${JSON.stringify(c.label)} for ${c.heading} (${c.source})`
            )
          }
        })

        it('should limit each chunk body to at most one runtime label (Java:/Node.js:)', () => {
          // java-div/node-div blocks produce a standalone 'Java:\n' or 'Node.js:\n' prefix line.
          // A split section must never land both in the same chunk.
          const JAVA_LABEL = /(?:^|\n\n)Java:\n/
          const NODE_LABEL = /(?:^|\n\n)Node\.js:\n/
          for (const c of outputFilter) {
            const hasJava = JAVA_LABEL.test(c.displayBody)
            const hasNode = NODE_LABEL.test(c.displayBody)
            assert.ok(
              !(hasJava && hasNode),
              `chunk body mixes Java: and Node.js: labels in "${c.heading}" (source=${c.source})`
            )
            if (c.label === 'java')
              assert.ok(!hasNode, `java-labeled chunk contains Node.js: block in "${c.heading}"`)
            if (c.label === 'node')
              assert.ok(!hasJava, `node-labeled chunk contains Java: block in "${c.heading}"`)
          }
        })

        it('should emit no duplicate embeddingBodies in filter output', () => {
          const seen = new Set()
          for (const c of outputFilter) {
            const key = `${c.label ?? ''}\0${c.embeddingBody}`
            assert.ok(
              !seen.has(key),
              `duplicate label+embeddingBody found (label=${c.label ?? 'none'}): ${JSON.stringify(c.embeddingBody.slice(0, 80))}`
            )
            seen.add(key)
          }
        })

        it('should give every chunk a non-empty embeddingBody and body string', () => {
          for (const chunk of outputFilter) {
            assert.strictEqual(typeof chunk.embeddingBody, 'string')
            assert.ok(chunk.embeddingBody.length > 0)
            assert.ok(chunk.displayBody.length > 0)
          }
        })

        // releases rule: no chunk from /docs/releases/ survives
        it('should drop every chunk from /docs/releases/', () => {
          for (const c of outputFilter)
            assert.ok(
              !/\/docs\/releases\//.test(c.source ?? ''),
              `releases chunk survived: ${c.source}`
            )
        })

        // empty/whitespace body rule: already covered by non-empty body test above

        // anchor-only body rule: no chunk body consists entirely of h4-h6 slug lines
        it('should drop a chunk whose body is anchor-only (h4-h6 slug lines only)', () => {
          for (const c of outputFilter) {
            const lines = c.displayBody.split('\n').filter((l) => l.trim())
            const allSlugs = lines.length > 0 && lines.every((l) => /^#{4,6}\s+\S/.test(l.trim()))
            assert.ok(
              !allSlugs,
              `anchor-only body survived filter: ${JSON.stringify(c.displayBody.slice(0, 80))}`
            )
          }
        })

        // valueless body rule: no placeholder stubs survive
        it('should drop a chunk whose body is a placeholder stub (coming soon / TBD / to be written)', () => {
          for (const c of outputFilter) {
            const b = c.displayBody.trim()
            assert.ok(
              !/^(will come soon|coming soon|tbd|to be (written|done|added))\.?$/i.test(b),
              `placeholder stub survived: ${JSON.stringify(b)}`
            )
            assert.ok(
              !/^this documentation is not (complete|available) yet/i.test(b),
              `incomplete-docs stub survived: ${JSON.stringify(b)}`
            )
          }
        })

        // redirect-stub rule: no chunk body is a bare single link with no surrounding prose
        it('should drop a chunk whose body is a bare redirect-stub (single link, no prose)', () => {
          for (const c of outputFilter) {
            const b = c.displayBody
            if (/```/.test(b)) continue
            if (/^\s*[-*+]\s/m.test(b)) continue
            if (/^\s*\|/m.test(b)) continue
            const links = b.match(/\[[^\]]*\]\([^)]*\)/g)
            if (!links || links.length !== 1) continue
            if (/^\[As in /i.test(links[0])) continue
            const stripped = b
              .replace(/!?\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '')
              .replace(/[\s#>*_|.-]/g, '')
              .trim()
            assert.ok(
              stripped !== '',
              `redirect-stub survived filter: ${JSON.stringify(b.slice(0, 100))}`
            )
          }
        })

        it('should keep only chunks whose displayBody meets minTokens', () => {
          assert.ok(outputFilter.length > 0)
          for (const c of outputFilter) {
            const b = c.displayBody.trim()
            assert.ok(
              config.measure(b) >= config.minTokens,
              `body below minTokens survived (tokens=${config.measure(b)}): ${JSON.stringify(b)}`
            )
          }
        })

        // body-hash dedup rule: verified by no-duplicate-bodies test above

        // filter produces output (sanity: not everything dropped)
        it('should produce a non-empty filter output', () => {
          assert.ok(outputFilter.length > 0, 'filter dropped everything')
        })
      })

      describe('given discarded sections and chunks', () => {
        it('should only discard empty bodies before parsing blocks', () => {
          const { args, result } = stageCalls.find(({ name }) => name === 'parseSectionBlocks')
          const removed = args[0].filter(
            (section) => !result.some((entry) => entry.section === section)
          )
          for (const section of removed) assert.strictEqual(section.body.trim(), '')
        })

        it('should remove undersized chunks from the corpus', () => {
          const { args, result } = stageCalls.find(({ name }) => name === 'filter')
          const undersized = args[0].filter(
            (chunk) => config.measure(chunk.displayBody.trim()) < config.minTokens
          )
          assert.ok(undersized.length > 0)
          for (const chunk of undersized) assert.ok(!result.includes(chunk))
        })

        it('should drop at least some chunks via filter (corpus is non-trivial)', () => {
          assert.ok(outputFilter.length < outputPackBlocks.length)
        })
      })
    })
  })
}

for (const { label, overrides } of CONFIGS) runE2ESuite(label, overrides)

// --- Focused cross-stage tests with tiny in-memory fixtures ---

describe('pipeline — focused fixture tests', () => {
  const configP = {
    minTokens: 0,
    maxHeadingDepth: 4,
    maxTokens: 1152,
    measure: mockMeasure
  }
  describe('when cross-stage transform + chunk', () => {
    it('should make split runtime wrappers share one body and carry the label on each embeddingBody', () => {
      const text = [
        '# Feature',
        '',
        '> Source: /docs/f',
        '',
        '<div class="impl java">',
        '',
        'First sentence contains enough Java-specific detail to split. Second sentence contains enough Java-specific detail to split.',
        '',
        '</div>'
      ].join('\n')
      const config = {
        ...configP,
        maxTokens: 70,
        measure: (value) => value.length
      }
      const sections = runPipeline(text, config)

      assert.ok(sections.length > 1)
      assert.ok(sections.every((chunk) => chunk.embeddingBody.startsWith('Java:\n')))
      assert.strictEqual(
        new Set(sections.map((chunk) => chunk.displayBody)).size,
        1,
        'all fragments must share one body'
      )
    })

    it('should not emit an empty bodyPart for a section with java-div content and an empty node-div', () => {
      const text = [
        '# Feature',
        '',
        '> Source: /docs/f',
        '',
        'intro',
        '<div class="impl java">',
        '',
        'Java specific instructions here that survive transform.',
        '',
        '</div>',
        '<div class="impl node">',
        '',
        '![decorative](./x.drawio)',
        '',
        '</div>'
      ].join('\n')
      const config = { ...configP }
      const sections = runPipeline(text, config)
      for (const c of sections) {
        assert.ok(
          c.displayBody && c.displayBody.trim() !== '',
          `no chunk may have empty body; got ${JSON.stringify(c)}`
        )
      }
      const anyJava = sections.some((c) => c.displayBody.includes('Java specific instructions'))
      assert.ok(anyJava, 'java-div content must survive')
    })

    it('should strip {.class} markers from the breadcrumb during transform', () => {
      const text = [
        '# Root {.some-marker}',
        '',
        '> Source: /docs/r',
        '',
        'root body large enough to survive the min chunk size filter comfortably.',
        '## Child',
        '',
        '> Source: /docs/r#c',
        '',
        'child body here large enough to survive the min chunk size filter comfortably.'
      ].join('\n')
      const config = { ...configP }
      const sections = runPipeline(text, config)
      const child = sections.find((c) => c.heading?.includes('Child'))
      assert.ok(child, 'child chunk expected')
      assert.ok(
        !/\{\.some-marker\}/.test(child.breadcrumb),
        `breadcrumb must be markerless; got: ${JSON.stringify(child.breadcrumb)}`
      )
    })
  })

  describe('when tracking dropped sections', () => {
    it('should discard transformed-empty sections and report counts only for the current run', (t) => {
      const text = [
        '# Empty',
        '',
        '> Source: /docs/empty',
        '',
        '![empty.svg](empty.svg)',
        '',
        '# Retained',
        '',
        '> Source: /docs/retained',
        '',
        'Retained content.',
        '',
        '![empty.svg](empty.svg)'
      ].join('\n')
      const log = t.mock.method(console, 'log', () => {})

      const sections = runPipeline(text, configP)

      assert.strictEqual(sections.length, 1)
      assert.strictEqual(sections[0].heading, '# Retained')
      assert.strictEqual(sections[0].displayBody, 'Retained content.')
      assert.strictEqual(log.mock.callCount(), 2)
      assert.match(log.mock.calls[0].arguments[0], /\[transform\] dropped 2 empty blocks/)
      assert.match(log.mock.calls[1].arguments[0], /\[transform\] dropped 1 empty sections/)
      log.mock.resetCalls()

      const next = runPipeline(
        '# Retained\n\n> Source: /docs/retained\n\nRetained content.',
        configP
      )

      assert.strictEqual(next.length, 1)
      assert.strictEqual(next[0].displayBody, 'Retained content.')
      assert.strictEqual(log.mock.callCount(), 0)
    })

    it('should drop an empty parent while retaining its deeper section and report the count', (t) => {
      const text = [
        '# Empty',
        '',
        '> Source: /docs/e',
        '',
        '   ',
        '',
        '## Real',
        '',
        '> Source: /docs/r',
        '',
        'real content that clears filters and is long enough to survive the size gate.'
      ].join('\n')
      const config = { ...configP }
      const log = t.mock.method(console, 'log', () => {})

      const sections = runPipeline(text, config)

      assert.strictEqual(sections.length, 1)
      assert.strictEqual(sections[0].heading, '## Real')
      assert.strictEqual(log.mock.callCount(), 1)
      assert.match(log.mock.calls[0].arguments[0], /\[parse-blocks\] dropped 1 empty body sections/)
    })
  })

  describe('when checking the metadata label', () => {
    it('should leave a prose-only section without a label (undefined)', () => {
      const text = [
        '# H',
        '',
        '> Source: /docs/h',
        '',
        'plain prose body long enough to survive filters, no code or divs here.'
      ].join('\n')
      const config = { ...configP }
      const sections = runPipeline(text, config)
      assert.ok(sections.length > 0)
      for (const c of sections)
        assert.strictEqual(c.label, undefined, `expected no label; got ${c.label} for ${c.heading}`)
    })

    it('should emit label="java" for a section with only a java-div', () => {
      const text = [
        '# F',
        '',
        '> Source: /docs/f',
        '',
        '<div class="impl java">',
        '',
        'Java-only instructions here, plenty of prose to clear filters.',
        '',
        '</div>'
      ].join('\n')
      const config = { ...configP }
      const sections = runPipeline(text, config)
      const javaChunk = sections.find((c) => c.displayBody.includes('Java-only instructions'))
      assert.ok(javaChunk, 'java-div chunk expected')
      assert.strictEqual(javaChunk.label, 'java')
    })

    it('should emit label="node" for a section with only a node-div', () => {
      const text = [
        '# F',
        '',
        '> Source: /docs/f',
        '',
        '<div class="impl node">',
        '',
        'Node-only instructions here, plenty of prose to clear filters.',
        '',
        '</div>'
      ].join('\n')
      const config = { ...configP }
      const sections = runPipeline(text, config)
      const nodeChunk = sections.find((c) => c.displayBody.includes('Node-only instructions'))
      assert.ok(nodeChunk, 'node-div chunk expected')
      assert.strictEqual(nodeChunk.label, 'node')
    })

    it('should split a section with both java-div and node-div into java- and node-labeled chunks', () => {
      const text = [
        '# Feature',
        '',
        '> Source: /docs/f',
        '',
        'intro paragraph long enough to be meaningful.',
        '<div class="impl java">',
        '',
        'Java specific instructions here that survive transform, meaningful prose.',
        '',
        '</div>',
        '<div class="impl node">',
        '',
        'Node specific instructions here that survive transform, meaningful prose.',
        '',
        '</div>'
      ].join('\n')
      const config = { ...configP }
      const sections = runPipeline(text, config)
      const javaChunk = sections.find((c) => c.displayBody.includes('Java specific instructions'))
      const nodeChunk = sections.find((c) => c.displayBody.includes('Node specific instructions'))
      assert.ok(javaChunk, 'java-labeled chunk expected')
      assert.ok(nodeChunk, 'node-labeled chunk expected')
      assert.strictEqual(javaChunk.label, 'java')
      assert.strictEqual(nodeChunk.label, 'node')
      assert.strictEqual(javaChunk.source, nodeChunk.source)
    })

    it('should give split java and node blocks different shared bodies', () => {
      const prose = (runtime) =>
        `${runtime} first sentence contains enough detail to fill a fragment. ${runtime} second sentence becomes another fragment. ${runtime} third sentence becomes a final fragment.`
      const text = [
        '# Feature',
        '',
        '> Source: /docs/f',
        '',
        '<div class="impl java">',
        '',
        prose('Java'),
        '',
        '</div>',
        '<div class="impl node">',
        '',
        prose('Node'),
        '',
        '</div>'
      ].join('\n')
      const config = {
        ...configP,
        maxTokens: 90,
        measure: (value) => value.length
      }
      const sections = runPipeline(text, config)
      const bodies = (runtime) =>
        new Set(sections.filter((c) => c.label === runtime).map((c) => c.displayBody))
      const javaBodies = bodies('java')
      const nodeBodies = bodies('node')

      assert.strictEqual(javaBodies.size, 1)
      assert.strictEqual(nodeBodies.size, 1)
      assert.notStrictEqual([...javaBodies][0], [...nodeBodies][0])
    })

    it('should keep both java and node variants with identical body text (not deduped across labels)', () => {
      const sharedBody =
        'Shared content that is identical in both runtime variants and long enough to survive filters.'
      const text = [
        '# Feature',
        '',
        '> Source: /docs/f',
        '',
        '<div class="impl java">',
        '',
        sharedBody,
        '',
        '</div>',
        '<div class="impl node">',
        '',
        sharedBody,
        '',
        '</div>'
      ].join('\n')
      const config = { ...configP }
      const sections = runPipeline(text, config)
      const javaChunk = sections.find(
        (c) => c.label === 'java' && c.displayBody.includes(sharedBody)
      )
      const nodeChunk = sections.find(
        (c) => c.label === 'node' && c.displayBody.includes(sharedBody)
      )
      assert.ok(javaChunk, 'java-labeled chunk must survive')
      assert.ok(nodeChunk, 'node-labeled chunk must survive')
    })

    it('should keep every chunk label in the known set when present', () => {
      const text = [
        '# A',
        '',
        '> Source: /docs/a',
        '',
        'body A meaningful and long enough to survive filters comfortably.',
        '## B',
        '',
        '> Source: /docs/a#b',
        '',
        'body B meaningful and long enough to survive filters comfortably.'
      ].join('\n')
      const KNOWN = new Set(['java', 'node'])
      const config = { ...configP }
      const sections = runPipeline(text, config)
      for (const c of sections) {
        if (c.label === undefined) continue
        assert.ok(KNOWN.has(c.label), `unknown label ${JSON.stringify(c.label)} for ${c.heading}`)
      }
    })
  })

  describe('when checking chunk boundary and idempotency', () => {
    const validationChunk = (body) => ({
      breadcrumb: 'Root',
      heading: '## Child',
      source: 'https://cap.cloud.sap/docs/root#child',
      displayBody: body,
      embeddingBody: body
    })

    it('should produce identical split Beta chunks alone and after unrelated Alpha', () => {
      const alpha = '# Alpha\n\n> Source: /docs/alpha\n\nUnrelated content.'
      const beta = [
        '# Beta',
        '',
        '> Source: /docs/beta',
        '',
        'Intro.',
        '',
        '## Beta Child',
        '',
        '> Source: /docs/beta#child',
        '',
        'First child sentence. Second child sentence.'
      ].join('\n')
      const config = { ...configP, maxHeadingDepth: 1, maxTokens: 50, measure: (t) => t.length }
      const pipelineUrl = new URL(
        '../../lib/markdownEmbeddings/chunker/pipeline.js',
        import.meta.url
      )
      // Fresh processes make the alone baseline independent of this suite's earlier invocations.
      const runIsolated = (inputs) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              '--input-type=module',
              '--eval',
              `import { runPipeline } from ${JSON.stringify(pipelineUrl.href)};
               const config = { ...${JSON.stringify(config)}, measure: (t) => t.length };
               const results = ${JSON.stringify(inputs)}.map((text) => runPipeline(text, config));
               process.stdout.write(JSON.stringify(results.at(-1)));`
            ],
            { encoding: 'utf8' }
          )
        )

      const alone = runIsolated([beta])
      const afterAlpha = runIsolated([alpha, beta])

      assert.strictEqual(alone.length, 3)
      assert.deepStrictEqual(afterAlpha, alone)
      assert.deepStrictEqual(
        alone.map((chunk) => chunk.embeddingBody),
        [
          'Intro.',
          '## Beta Child\n\nFirst child sentence.',
          '## Beta Child\n\nSecond child sentence.'
        ]
      )
      assert.deepStrictEqual(
        alone.map((chunk) => chunk.displayBody),
        [
          'Intro.',
          '## Beta Child\n\nFirst child sentence. Second child sentence.',
          '## Beta Child\n\nFirst child sentence. Second child sentence.'
        ]
      )
      for (const chunk of alone) {
        assert.strictEqual(chunk.heading, '# Beta')
        assert.strictEqual(chunk.source, 'https://cap.cloud.sap/docs/beta')
        assert.ok(config.measure(embedText(chunk)) <= config.maxTokens)
      }
    })

    it('should emit rendered embedding text at exactly maxTokens as one chunk (not split)', () => {
      const paragraph = 'x'.repeat(195)
      const text = ['# H', '', '> Source: /docs/h', '', paragraph].join('\n')
      // Heading and separator add 5 chars: 200 chars → mockMeasure = 50 tokens.
      const config = { ...configP, maxTokens: 50 }
      const sections = runPipeline(text, config)
      assert.strictEqual(sections.length, 1)
      assert.strictEqual(sections[0].embeddingBody, paragraph)
      assert.strictEqual(sections[0].displayBody, paragraph)
      assert.strictEqual(config.measure(embedText(sections[0])), config.maxTokens)
    })

    it('should split body-only fits using each heading and retain all embedding content', () => {
      const fixtures = [
        { heading: '# Root', body: 'r'.repeat(25), fragments: [22, 3] },
        { heading: '## Child', body: 'c'.repeat(25), fragments: [20, 5] },
        { heading: '## Longer Child', body: 'l'.repeat(25), fragments: [13, 12] }
      ]
      const text = fixtures
        .map(({ heading, body }, index) => `${heading}\n\n> Source: /docs/root#${index}\n\n${body}`)
        .join('\n\n')
      const config = { ...configP, maxTokens: 30, measure: (value) => value.length }

      const sections = runPipeline(text, config)

      assert.strictEqual(sections.length, 6)
      for (const { heading, body, fragments } of fixtures) {
        const chunks = sections.filter((chunk) => chunk.heading === heading)
        assert.strictEqual(chunks.length, 2)
        assert.deepStrictEqual(
          chunks.map((chunk) => chunk.embeddingBody.length),
          fragments
        )
        assert.strictEqual(chunks.map((chunk) => chunk.embeddingBody).join(''), body)
        for (const chunk of chunks) {
          assert.strictEqual(chunk.displayBody, body)
          assert.strictEqual(embedText(chunk), `${heading}\n\n${chunk.embeddingBody}`)
          assert.ok(config.measure(embedText(chunk)) <= config.maxTokens)
        }
      }
    })

    it('should measure the complete rendered candidate instead of subtracting heading tokens', () => {
      const text = '## Child\n\n> Source: /docs/root#child\n\n' + 'c'.repeat(25)
      // Model a tokenizer whose heading/body boundary is not additive.
      const measure = (value) => value.length + (value.includes('\n\n') ? 4 : 0)
      const config = { ...configP, maxTokens: 30, measure }

      const sections = runPipeline(text, config)

      assert.strictEqual(sections.length, 2)
      assert.deepStrictEqual(
        sections.map((chunk) => chunk.embeddingBody.length),
        [16, 9]
      )
      assert.strictEqual(sections.map((chunk) => chunk.embeddingBody).join(''), 'c'.repeat(25))
      for (const chunk of sections) assert.ok(measure(embedText(chunk)) <= config.maxTokens)
    })

    it('should keep minTokens based on the body rather than heading overhead', (t) => {
      const text = '# Root\n\n> Source: /docs/root\n\nShort.'
      const log = t.mock.method(console, 'log', () => {})
      const config = { ...configP, maxTokens: 30, minTokens: 10, measure: (value) => value.length }

      const sections = runPipeline(text, config)

      assert.strictEqual(sections.length, 0)
      assert.match(log.mock.calls[0].arguments[0], /dropped 1 toSmallBody chunks/)
    })

    it('should reject a body-only fit whose heading and separator exceed maxTokens', (t) => {
      const stderr = t.mock.method(process.stderr, 'write', () => true)
      const chunks = [validationChunk('c'.repeat(25))]
      const config = { ...configP, maxTokens: 30, measure: (value) => value.length }

      assert.throws(() => stages.validate(chunks, config), /1 chunk\(s\) failed validation/)

      assert.strictEqual(stderr.mock.callCount(), 1)
      assert.match(
        stderr.mock.calls[0].arguments[0],
        /oversized embedding text \(35 > 30 tokens\): ## Child/
      )
    })

    it('should accept complete rendered text at exactly maxTokens without changing chunks', (t) => {
      const stderr = t.mock.method(process.stderr, 'write', () => true)
      const chunks = [validationChunk('c'.repeat(20))]
      const original = structuredClone(chunks)
      const config = { ...configP, maxTokens: 30, measure: (value) => value.length }

      const result = stages.validate(chunks, config)

      assert.strictEqual(result, chunks)
      assert.deepStrictEqual(chunks, original)
      assert.strictEqual(stderr.mock.callCount(), 0)
    })

    it('should warn on a short body even when heading overhead reaches minTokens', (t) => {
      const stderr = t.mock.method(process.stderr, 'write', () => true)
      const chunks = [validationChunk('Short.')]
      const config = { ...configP, maxTokens: 30, minTokens: 10, measure: (value) => value.length }

      assert.strictEqual(stages.validate(chunks, config), chunks)

      assert.strictEqual(stderr.mock.callCount(), 1)
      assert.match(stderr.mock.calls[0].arguments[0], /short embedding body \(6 tokens\): ## Child/)
    })

    for (const maxTokens of [7, 8, 10]) {
      it(`should reject in validation when heading overhead leaves no content budget (${maxTokens} tokens)`, (t) => {
        const stderr = t.mock.method(process.stderr, 'write', () => true)
        const text = '## Child\n\n> Source: /docs/root#child\n\nx'
        const config = { ...configP, maxTokens, measure: (value) => value.length }

        assert.throws(
          () => runPipeline(text, config),
          /\[validate\] 1 chunk\(s\) failed validation/
        )

        assert.strictEqual(stderr.mock.callCount(), 1)
        assert.match(
          stderr.mock.calls[0].arguments[0],
          new RegExp(`oversized embedding text \\(11 > ${maxTokens} tokens\\): ## Child`)
        )
      })
    }

    it('should yield a stable non-empty chunk set when running the pipeline on its own serialized output', () => {
      const text = [
        '# A',
        '',
        '> Source: /docs/a',
        '',
        'body of A that is meaningful and lengthy enough to survive filters easily even after re-parsing runs again.',
        '## B',
        '',
        '> Source: /docs/a#b',
        '',
        'body of B that is meaningful and lengthy enough to survive filters easily even after re-parsing runs again.'
      ].join('\n')
      const config = { ...configP }
      const first = runPipeline(text, config)
      assert.ok(first.length > 0, 'first run must yield sections')
      const roundtrip = first
        .map((c) =>
          [c.breadcrumb, c.heading, c.source ? `> Source: ${c.source}` : null, c.displayBody]
            .filter(Boolean)
            .join('\n\n')
        )
        .join('\n\n')
      const second = runPipeline(roundtrip, config)
      assert.ok(
        second.length > 0,
        `second run must yield sections; roundtrip len=${roundtrip.length}`
      )
    })
  })
})
