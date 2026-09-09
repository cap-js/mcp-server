import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveIds, buildSourceMapIndex, isLlmFallbackEnabled } from '../../lib/ids.js'
import Anthropic from '@anthropic-ai/sdk'

// Shared Anthropic Messages prototype for mock patching across LLM tests.
// Dynamic import inside ids.js returns the same cached module, so mutations
// on this prototype are seen by all Anthropic instances.
const _tmpA = new Anthropic({ apiKey: 'test-key-for-proto-access' })
const _MessagesProto = Object.getPrototypeOf(_tmpA.messages)
const _origCreate = _MessagesProto.create

const SM = [
  { source: '/docs/get-started/', title: 'Getting Started', depth: 1 },
  { source: '/docs/get-started/#initial-setup', title: 'Initial Setup', depth: 2 },
  { source: '/docs/get-started/#nodejs-and-cds-dk', title: 'Node.js and _cds-dk_', depth: 3 }
]
const Q = { id: 'q1', question: 'test?' }

describe('ids tests', async () => {
  test('single chunk with Source: line → one id, text preserved', async () => {
    const text = '# Getting Started\n\nSource: /docs/get-started/\nbody'
    const r = await resolveIds([text], Q, SM)
    assert.equal(r.length, 1)
    assert.deepEqual(r[0].ids, ['/docs/get-started/'])
    assert.equal(r[0].text, text)
  })

  test('Source: line is matched at position i+2 (one blank line between heading and source)', async () => {
    const text = '# Section A\n\nSource: /docs/a\nmore'
    const r = await resolveIds([text], Q, [])
    assert.deepEqual(r[0].ids, ['/docs/a'])
  })

  test('heading lookup via sourceMap when no inline Source: line', async () => {
    // lines[0] = 'Getting Started' → breadcrumb matches top-level entry → /docs/get-started/
    const text = 'Getting Started\n## Initial Setup\nbody'
    const r = await resolveIds([text], Q, SM)
    assert.deepEqual(r[0].ids, ['/docs/get-started/'])
  })

  test('multi-section chunk collects ids from multiple Source: lines', async () => {
    const text = [
      '# Getting Started',
      '',
      'Source: /docs/get-started/',
      'intro',
      '## Initial Setup',
      '',
      'Source: /docs/get-started/#initial-setup',
      'setup body'
    ].join('\n')
    const r = await resolveIds([text], Q, SM)
    assert.ok(r[0].ids.includes('/docs/get-started/'))
    assert.ok(r[0].ids.includes('/docs/get-started/#initial-setup'))
  })

  test('two independent chunks → two result entries', async () => {
    const sm = [{ source: '/a', title: 'A', depth: 1 }, { source: '/b', title: 'B', depth: 1 }]
    const c1 = '# A\n\nSource: /a\nbody'
    const c2 = '# B\n\nSource: /b\nbody'
    const r = await resolveIds([c1, c2], Q, sm)
    assert.equal(r.length, 2)
    assert.deepEqual(r[0].ids, ['/a'])
    assert.deepEqual(r[1].ids, ['/b'])
  })

  test('empty chunk (no breadcrumb) → returns placeholder id', async () => {
    const r = await resolveIds([''], Q, [])
    assert.equal(r.length, 1)
    assert.ok(r[0].ids[0].startsWith('/placeholder/source/'))
  })

  test('chunk with breadcrumb but no source match → returns placeholder id', async () => {
    const r = await resolveIds(['Heading A\nbody\nmore body\nstill no source'], Q, [])
    assert.equal(r.length, 1)
    assert.ok(r[0].ids[0].startsWith('/placeholder/source/'))
  })

  test('empty chunks array → returns empty array', async () => {
    assert.deepEqual(await resolveIds([], Q, []), [])
  })

  test('text with "source: " substring but no URL after colon → ids empty → throws "No IDs found"', async () => {
    // TODO: Review AI Test
    // 'source: ' enters new-behavior path but SOURCE regex requires \S+ → no match → ids stays empty
    await assert.rejects(
      () => resolveIds(['source: '], Q, [], null, silentLogger),
      { message: 'No IDs found' }
    )
  })

  test('breadcrumb-only heading resolved via getSourceByBreadCrump', async () => {
    // Two entries share title "Setup" at depth 2 — disambiguation via breadcrumb.
    const sm = [
      { source: '/docs/a/', title: 'A', depth: 1, breadcrumb: 'A' },
      { source: '/docs/a/#setup', title: 'Setup', depth: 2, breadcrumb: 'A > Setup' },
      { source: '/docs/b/', title: 'B', depth: 1, breadcrumb: 'B' },
      { source: '/docs/b/#setup', title: 'Setup', depth: 2, breadcrumb: 'B > Setup' }
    ]
    // lines[0] = 'B' → breadcrumb 'B' matches top-level entry → /docs/b/
    const text = 'B\n## Setup\nbody'
    const r = await resolveIds([text], Q, sm)
    assert.deepEqual(r[0].ids, ['/docs/b/'])
  })
})

const silentLogger = { warn() {}, log() {}, error() {} }

describe('isLlmFallbackEnabled', () => {
  let savedFallback, savedKey

  beforeEach(() => {
    savedFallback = process.env.EVAL_LLM_FALLBACK
    savedKey = process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (savedFallback === undefined) delete process.env.EVAL_LLM_FALLBACK
    else process.env.EVAL_LLM_FALLBACK = savedFallback
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedKey
  })

  test('returns true when EVAL_LLM_FALLBACK=true and ANTHROPIC_API_KEY set', () => {
    // TODO: Review AI Test
    process.env.EVAL_LLM_FALLBACK = 'true'
    process.env.ANTHROPIC_API_KEY = 'sk-test'

    assert.equal(isLlmFallbackEnabled(), true)
  })

  test('returns false when ANTHROPIC_API_KEY absent', () => {
    // TODO: Review AI Test
    process.env.EVAL_LLM_FALLBACK = 'true'
    delete process.env.ANTHROPIC_API_KEY

    assert.equal(isLlmFallbackEnabled(), false)
  })

  test('returns false when EVAL_LLM_FALLBACK is not "true"', () => {
    // TODO: Review AI Test
    process.env.EVAL_LLM_FALLBACK = '1'
    process.env.ANTHROPIC_API_KEY = 'sk-test'

    assert.equal(isLlmFallbackEnabled(), false)
  })

  test('returns false when EVAL_LLM_FALLBACK absent', () => {
    // TODO: Review AI Test
    delete process.env.EVAL_LLM_FALLBACK
    process.env.ANTHROPIC_API_KEY = 'sk-test'

    assert.equal(isLlmFallbackEnabled(), false)
  })
})

describe('buildSourceMapIndex', () => {
  const sm = [
    { source: '/a', title: 'A', depth: 1, breadcrumb: 'A', nonTransformedBreadcrumb: 'A_nt' },
    { source: '/b', title: 'A', depth: 2 },
    { source: '/c', title: 'C', depth: 1 },
    { source: '/d', title: 'C', depth: 1 }
  ]
  let idx

  beforeEach(() => { idx = buildSourceMapIndex(sm) })

  test('byBreadcrumb maps breadcrumb string to entry', () => {
    // TODO: Review AI Test
    assert.equal(idx.byBreadcrumb.get('A'), sm[0])
    assert.equal(idx.byBreadcrumb.has(''), false)
  })

  test('byBreadcrumb skips entries without breadcrumb property', () => {
    // TODO: Review AI Test
    assert.equal(idx.byBreadcrumb.size, 1)
  })

  test('byNonTransformed maps nonTransformedBreadcrumb to entry', () => {
    // TODO: Review AI Test
    assert.equal(idx.byNonTransformed.get('A_nt'), sm[0])
    assert.equal(idx.byNonTransformed.size, 1)
  })

  test('byTitle groups all entries sharing a title into an array', () => {
    // TODO: Review AI Test
    assert.deepEqual(idx.byTitle.get('A'), [sm[0], sm[1]])
    assert.deepEqual(idx.byTitle.get('C'), [sm[2], sm[3]])
  })

  test('byTitleDepth groups by title::depth composite key', () => {
    // TODO: Review AI Test
    assert.deepEqual(idx.byTitleDepth.get('A::1'), [sm[0]])
    assert.deepEqual(idx.byTitleDepth.get('A::2'), [sm[1]])
    assert.deepEqual(idx.byTitleDepth.get('C::1'), [sm[2], sm[3]])
  })

  test('bySource groups all entries sharing a source into an array', () => {
    // TODO: Review AI Test
    assert.deepEqual(idx.bySource.get('/a'), [sm[0]])
    assert.deepEqual(idx.bySource.get('/c'), [sm[2]])
  })

  test('empty sourceMap → all maps are empty', () => {
    // TODO: Review AI Test
    const emptyIdx = buildSourceMapIndex([])

    assert.equal(emptyIdx.byBreadcrumb.size, 0)
    assert.equal(emptyIdx.byNonTransformed.size, 0)
    assert.equal(emptyIdx.byTitle.size, 0)
    assert.equal(emptyIdx.byTitleDepth.size, 0)
    assert.equal(emptyIdx.bySource.size, 0)
  })
})

describe('resolveIds - HeadingPath line', () => {
  test('HeadingPath used as breadcrumb for sourceMap lookup when no inline Source:', async () => {
    // TODO: Review AI Test
    const sm = [
      { source: '/docs/section-a', title: 'Section A', depth: 1, breadcrumb: 'Docs > Section A' }
    ]
    const text = 'HeadingPath: Docs > Section A\nbody without source line'

    const r = await resolveIds([text], Q, sm, null, silentLogger)

    assert.deepEqual(r[0].ids, ['/docs/section-a'])
  })

  test('HeadingPath heading stripped before breadcrumb join', async () => {
    // TODO: Review AI Test
    const sm = [
      { source: '/docs/x', title: 'X', depth: 1, breadcrumb: 'X' }
    ]
    const text = 'HeadingPath: X\nbody'

    const r = await resolveIds([text], Q, sm, null, silentLogger)

    assert.deepEqual(r[0].ids, ['/docs/x'])
  })
})

describe('resolveIds - nonTransformedBreadcrumb lookup', () => {
  test('falls back to nonTransformedBreadcrumb when byBreadcrumb misses', async () => {
    // TODO: Review AI Test
    const sm = [
      { source: '/docs/a/', title: 'A transformed', depth: 1, nonTransformedBreadcrumb: 'A (original)' }
    ]
    const text = 'A (original)\nbody'

    const r = await resolveIds([text], Q, sm, null, silentLogger)

    assert.deepEqual(r[0].ids, ['/docs/a/'])
  })
})

describe('resolveIds - byTitle disambiguation (no inline Source:)', () => {
  test('single byTitle match used when breadcrumb not found', async () => {
    // TODO: Review AI Test
    const sm = [{ source: '/docs/setup', title: 'Setup', depth: 1 }]
    const text = 'Setup\nbody'

    const r = await resolveIds([text], Q, sm, null, silentLogger)

    assert.deepEqual(r[0].ids, ['/docs/setup'])
  })

  test('multiple byTitle candidates → placeholder with "Multiple" warning', async () => {
    // TODO: Review AI Test
    const sm = [
      { source: '/docs/a/setup', title: 'Setup', depth: 1 },
      { source: '/docs/b/setup', title: 'Setup', depth: 1 }
    ]
    const text = 'Setup\nbody'
    const warnings = []
    const logger = { warn: msg => warnings.push(msg) }

    const r = await resolveIds([text], Q, sm, null, logger)

    assert.ok(r[0].ids[0].startsWith('/placeholder/source/'))
    assert.ok(warnings.some(w => w.startsWith('Multiple')))
  })

  test('zero byTitle candidates → placeholder with "No" warning', async () => {
    // TODO: Review AI Test
    const sm = [{ source: '/docs/other', title: 'Other', depth: 1 }]
    const text = 'UnknownTitle\nbody'
    const warnings = []
    const logger = { warn: msg => warnings.push(msg) }

    const r = await resolveIds([text], Q, sm, null, logger)

    assert.ok(r[0].ids[0].startsWith('/placeholder/source/'))
    assert.ok(warnings.some(w => w.startsWith('No')))
  })
})

describe('resolveIds - source: new behavior heading lookup', () => {
  test('sub-heading resolved via byTitleDepth single match', async () => {
    // TODO: Review AI Test
    const sm = [
      { source: '/docs/a/', title: 'Getting Started', depth: 1 },
      { source: '/docs/a/#setup', title: 'Setup', depth: 2 }
    ]
    const text = [
      '# Getting Started',
      '',
      'Source: /docs/a/',
      '## Setup',
      'content'
    ].join('\n')

    const r = await resolveIds([text], Q, sm, null, silentLogger)

    assert.ok(r[0].ids.includes('/docs/a/'))
    assert.ok(r[0].ids.includes('/docs/a/#setup'))
  })

  test('sub-heading with multiple byTitleDepth matches resolved via breadcrumb', async () => {
    // TODO: Review AI Test
    const sm = [
      { source: '/docs/a/', title: 'Section A', depth: 1, breadcrumb: 'Section A' },
      { source: '/docs/a/#setup', title: 'Setup', depth: 2, breadcrumb: 'Section A > Setup' },
      { source: '/docs/b/', title: 'Section B', depth: 1, breadcrumb: 'Section B' },
      { source: '/docs/b/#setup', title: 'Setup', depth: 2, breadcrumb: 'Section B > Setup' }
    ]
    const text = [
      '# Section A',
      '',
      'Source: /docs/a/',
      '## Setup',
      'content'
    ].join('\n')

    const r = await resolveIds([text], Q, sm, null, silentLogger)

    assert.deepEqual(r[0].ids, ['/docs/a/', '/docs/a/#setup'])
  })

  test('sub-heading with multiple byTitleDepth matches resolved via linear scan when breadcrumb absent', async () => {
    // TODO: Review AI Test
    const sm = [
      { source: '/docs/a/', title: 'Section A', depth: 1 },
      { source: '/docs/a/#setup', title: 'Setup', depth: 2 },
      { source: '/docs/b/', title: 'Section B', depth: 1 },
      { source: '/docs/b/#setup', title: 'Setup', depth: 2 }
    ]
    const text = [
      '# Section A',
      '',
      'Source: /docs/a/',
      '## Setup',
      'content'
    ].join('\n')

    const r = await resolveIds([text], Q, sm, null, silentLogger)

    assert.ok(r[0].ids.includes('/docs/a/'))
    assert.ok(r[0].ids.includes('/docs/a/#setup'))
  })

  test('sub-heading not in byTitleDepth → skipped, no placeholder', async () => {
    // TODO: Review AI Test
    const sm = [
      { source: '/docs/a/', title: 'Section A', depth: 1 }
    ]
    const text = [
      '# Section A',
      '',
      'Source: /docs/a/',
      '## Unknown Subsection',
      'content'
    ].join('\n')

    const r = await resolveIds([text], Q, sm, null, silentLogger)

    assert.deepEqual(r[0].ids, ['/docs/a/'])
  })

  test('sub-heading with multiple byTitleDepth matches, breadcrumb miss, linear scan miss → placeholder', async () => {
    // TODO: Review AI Test
    // Setup entries appear BEFORE the parent in sourceMap so linear scan (start+1 onward) finds nothing
    const sm = [
      { source: '/docs/b/#setup', title: 'Setup', depth: 2 },
      { source: '/docs/c/#setup', title: 'Setup', depth: 2 },
      { source: '/docs/a/', title: 'Section A', depth: 1 }
    ]
    const text = [
      '# Section A',
      '',
      'Source: /docs/a/',
      '## Setup',
      'content'
    ].join('\n')
    const warnings = []
    const logger = { warn: msg => warnings.push(msg) }

    const r = await resolveIds([text], Q, sm, null, logger)

    assert.ok(r[0].ids.includes('/docs/a/'))
    assert.ok(r[0].ids.some(id => id.startsWith('/placeholder/source/')))
    assert.ok(warnings.some(w => w.includes('placeholder source')))
  })

  test('intermediate heading overwrites firstHeading, backward scan unshifts (L170-172) then breaks at depth-1 (L174)', async () => {
    // TODO: Review AI Test
    // # Top → ## Redefine (overrides firstHeading: ids.length=0 on second heading) → Source → ### Deep
    // Backward scan from ### Deep: ## Redefine (depth 2 < 3 → unshift), # Top (depth 1 ≤ 1 → break)
    const sm = [
      { source: '/docs/a/', title: 'Redefine', depth: 2 },
      { source: '/docs/a/#deep1', title: 'Deep', depth: 3, breadcrumb: 'Top > Top > Redefine > Deep' },
      { source: '/docs/b/#deep2', title: 'Deep', depth: 3, breadcrumb: 'Other > Deep' }
    ]
    const text = ['# Top', '## Redefine', 'Source: /docs/a/', '### Deep', 'content'].join('\n')

    const r = await resolveIds([text], Q, sm, null, silentLogger)

    assert.ok(r[0].ids.includes('/docs/a/'))
    assert.ok(r[0].ids.includes('/docs/a/#deep1'))
  })

  test('linear scan skips lower-depth entries via continue (L185) before finding the match', async () => {
    // TODO: Review AI Test
    // Multiple byTitleDepth matches for Deep::3, no breadcrumb → linear scan
    // sm[1] has depth=1 < 3 → L185: current.depth < depth → true → continue
    // sm[2] has depth=3 and title=Deep → found
    const sm = [
      { source: '/docs/a/', title: 'Section A', depth: 1 },
      { source: '/docs/x/', title: 'X', depth: 1 },            // depth 1 < 3 → L185 continue
      { source: '/docs/a/#deep', title: 'Deep', depth: 3 },
      { source: '/docs/b/', title: 'Section B', depth: 1 },
      { source: '/docs/b/#deep', title: 'Deep', depth: 3 }
    ]
    const text = ['# Section A', '', 'Source: /docs/a/', '### Deep', 'content'].join('\n')

    const r = await resolveIds([text], Q, sm, null, silentLogger)

    assert.ok(r[0].ids.includes('/docs/a/'))
    assert.ok(r[0].ids.includes('/docs/a/#deep'))
  })
})

describe('resolveIds - LLM fallback (pushPlaceholderOrLlm)', () => {
  let savedFallback, savedKey

  beforeEach(() => {
    savedFallback = process.env.EVAL_LLM_FALLBACK
    savedKey = process.env.ANTHROPIC_API_KEY
    process.env.EVAL_LLM_FALLBACK = 'true'
    process.env.ANTHROPIC_API_KEY = 'sk-test'
  })

  afterEach(() => {
    _MessagesProto.create = _origCreate
    if (savedFallback === undefined) delete process.env.EVAL_LLM_FALLBACK
    else process.env.EVAL_LLM_FALLBACK = savedFallback
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedKey
  })

  test('empty sourceMap → llmResolvePlaceholder returns null early (L24), falls through to placeholder', async () => {
    // TODO: Review AI Test
    const warnings = []

    const r = await resolveIds([''], Q, [], null, { warn: m => warnings.push(m) })

    assert.ok(r[0].ids[0].startsWith('/placeholder/source/'))
    assert.ok(warnings.some(w => w.startsWith('No breadcrumb')))
  })

  test('API throws → catch logs "LLM fallback failed" (L47-49), placeholder pushed', async () => {
    // TODO: Review AI Test
    const sm = [{ source: '/docs/a/', title: 'A', depth: 1 }]
    const warnings = []
    _MessagesProto.create = async () => { throw new Error('boom') }

    const r = await resolveIds(['Unknown\nbody'], Q, sm, null, { warn: m => warnings.push(m) })

    assert.ok(r[0].ids[0].startsWith('/placeholder/source/'))
    assert.ok(warnings.some(w => w.startsWith('LLM fallback failed')))
  })

  test('API returns "NONE" → llmResolvePlaceholder returns null (L43), placeholder pushed', async () => {
    // TODO: Review AI Test
    const sm = [{ source: '/docs/a/', title: 'A', depth: 1 }]
    _MessagesProto.create = async () => ({ content: [{ text: 'NONE' }] })

    const r = await resolveIds(['Unknown\nbody'], Q, sm, null, silentLogger)

    assert.ok(r[0].ids[0].startsWith('/placeholder/source/'))
  })

  test('API returns out-of-range number → llmResolvePlaceholder returns null (L45), placeholder pushed', async () => {
    // TODO: Review AI Test
    const sm = [{ source: '/docs/a/', title: 'A', depth: 1 }]
    _MessagesProto.create = async () => ({ content: [{ text: '0' }] })

    const r = await resolveIds(['Unknown\nbody'], Q, sm, null, silentLogger)

    assert.ok(r[0].ids[0].startsWith('/placeholder/source/'))
  })

  test('API returns valid number → picked source pushed, "Added source found by llm" warned (L46, L78-79)', async () => {
    // TODO: Review AI Test
    const sm = [{ source: '/docs/a/', title: 'A', depth: 1 }]
    const warnings = []
    _MessagesProto.create = async () => ({ content: [{ text: '1' }] })

    const r = await resolveIds(['Unknown\nbody'], Q, sm, null, { warn: m => warnings.push(m) })

    assert.deepEqual(r[0].ids, ['/docs/a/'])
    assert.ok(warnings.some(w => w.startsWith('Added source found by llm')))
  })

  test('API returns null text → treated as empty string, returns null (L42 ?. branch, L44 || branch)', async () => {
    // TODO: Review AI Test
    const sm = [{ source: '/docs/a/', title: 'A', depth: 1 }]
    _MessagesProto.create = async () => ({ content: [{ text: null }] })

    const r = await resolveIds(['Unknown\nbody'], Q, sm, null, silentLogger)

    assert.ok(r[0].ids[0].startsWith('/placeholder/source/'))
  })

  test('LLM candidate list uses c.breadcrumb when present, c.source when breadcrumb and title absent (L27 branches)', async () => {
    // TODO: Review AI Test
    const sm = [
      { source: '/x', breadcrumb: 'X breadcrumb', depth: 1 }, // c.breadcrumb branch
      { source: '/y', depth: 1 }                               // c.source branch (no breadcrumb, no title)
    ]
    const warnings = []
    _MessagesProto.create = async () => ({ content: [{ text: '2' }] })

    const r = await resolveIds(['Unknown\nbody'], Q, sm, null, { warn: m => warnings.push(m) })

    assert.deepEqual(r[0].ids, ['/y'])
    assert.ok(warnings.some(w => w.startsWith('Added source found by llm')))
  })
})

describe('resolveIds - pre-built smIndex', () => {
  test('accepts pre-built index and returns same result as auto-building', async () => {
    // TODO: Review AI Test
    const sm = [{ source: '/docs/a/', title: 'A', depth: 1, breadcrumb: 'A' }]
    const text = 'A\nbody'
    const smIndex = buildSourceMapIndex(sm)

    const withIndex = await resolveIds([text], Q, sm, smIndex, silentLogger)
    const withoutIndex = await resolveIds([text], Q, sm, null, silentLogger)

    assert.deepEqual(withIndex, withoutIndex)
  })
})

describe('side-effects', () => {
  test('resolveIds does not mutate the results array', async () => {
    // TODO: Review AI Test
    const text = '# A\n\nSource: /a\nbody'
    const results = [text]
    const keysBefore = Object.keys(results).sort()

    await resolveIds(results, Q, SM, null, silentLogger)

    assert.deepEqual(Object.keys(results).sort(), keysBefore)
    assert.equal(results[0], text)
  })

  test('resolveIds does not mutate the sourceMap array', async () => {
    // TODO: Review AI Test
    const sm = [{ source: '/docs/a/', title: 'A', depth: 1, breadcrumb: 'A' }]
    const smCopy = JSON.parse(JSON.stringify(sm))
    const text = 'A\nbody'

    await resolveIds([text], Q, sm, null, silentLogger)

    assert.deepEqual(sm, smCopy)
  })

  test('resolveIds does not mutate the query object', async () => {
    // TODO: Review AI Test
    const q = { id: 'q-side', question: 'test?' }
    const keysBefore = Object.keys(q).sort()
    const text = '# A\n\nSource: /a\nbody'

    await resolveIds([text], q, SM, null, silentLogger)

    assert.deepEqual(Object.keys(q).sort(), keysBefore)
    assert.equal(q.id, 'q-side')
    assert.equal(q.question, 'test?')
  })

  test('buildSourceMapIndex does not mutate the input array', async () => {
    // TODO: Review AI Test
    const sm = [{ source: '/a', title: 'A', depth: 1, breadcrumb: 'A' }]
    const smCopy = JSON.parse(JSON.stringify(sm))

    buildSourceMapIndex(sm)

    assert.deepEqual(sm, smCopy)
  })
})
