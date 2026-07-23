#!/usr/bin/env node
// Level-B end-to-end agentic eval harness — SKELETON.
//
// Everything except the arm-specific agent spawn (runAgent) is implemented:
// workspace setup, assertion running, aggregation, red/green matrix. Wire
// runAgent() to your chosen agent runtime (see the TODO) and this runs.
//
//   node evals/e2e/run.mjs --arms none,skills,mcp,mcp+skills --reps 3
//   node evals/e2e/run.mjs --tasks add-reviews-entity --arms mcp,skills

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { normalizeUsage, totalTokens, costUSD } from './pricing.js'

const execFileP = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, 'tasks')

// Path to a local capire/skills checkout for the `skills` arms.
// Clone: git clone https://github.com/capire/skills.git
const SKILLS_DIR = process.env.CAP_SKILLS_DIR || path.join(os.homedir(), 'git/capire/skills')

const LLMS_TXT_URL = process.env.CAP_LLMS_TXT || 'https://cap.cloud.sap/docs/llms.txt'

const ARM_CONFIG = {
  none: { mcp: false, skills: false, llmsTxt: false },
  'llms-txt': { mcp: false, skills: false, llmsTxt: true },
  skills: { mcp: false, skills: true, llmsTxt: false },
  mcp: { mcp: true, skills: false, llmsTxt: false },
  'mcp+skills': { mcp: true, skills: true, llmsTxt: false }
}

function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  if (hit) return hit.split('=')[1]
  const idx = process.argv.indexOf(`--${name}`)
  return idx !== -1 ? process.argv[idx + 1] : dflt
}

async function loadTasks(filter) {
  const ids = (await fs.readdir(TASKS_DIR, { withFileTypes: true }))
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(id => !filter || filter.includes(id))
  const tasks = []
  for (const id of ids) {
    const spec = JSON.parse(await fs.readFile(path.join(TASKS_DIR, id, 'task.json'), 'utf-8'))
    tasks.push({ ...spec, dir: path.join(TASKS_DIR, id) })
  }
  return tasks
}

async function makeWorkspace(task) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), `cap-eval-${task.id}-`))
  if (task.fixture) {
    await fs.cp(path.join(task.dir, task.fixture), ws, { recursive: true })
  }
  // copy any checker scripts alongside the fixture
  for (const f of await fs.readdir(task.dir)) {
    if (f.endsWith('.mjs') || f === 'check.mjs') {
      await fs.copyFile(path.join(task.dir, f), path.join(ws, f)).catch(() => {})
    }
  }
  return ws
}

/**
 * Run an agent on the task in the given workspace under the given arm.
 * MUST return:
 *   {
 *     transcript: string,
 *     model: string,              // e.g. 'claude-sonnet-5' — keys into pricing.js
 *     turns: number,
 *     tools: string[],            // tool names invoked (attributes value per tool)
 *     tokens: {                   // pass whatever your runtime reports; normalizeUsage
 *       input, output,            // handles snake_case (input_tokens, …) too
 *       cacheRead, cacheWrite,    // optional — priced separately in pricing.js
 *       toolResult                // optional — tokens from tool results (search_docs
 *     }                           // output). Set for MCP arms to see doc-chunk cost.
 *   }
 * Missing token fields default to 0, so partial telemetry is fine (cost is just
 * under-counted). At minimum capture input + output.
 *
 * TODO(you): wire this to your agent runtime. Sketch:
 *
 *   const mcpServers = arm.mcp
 *     ? { 'cds-mcp': { command: 'npx', args: ['-y', '@cap-js/mcp-server'] } }
 *     : {}
 *   let systemExtra = arm.skills ? await loadSkillsContext() : ''
 *   if (arm.llmsTxt) {
 *     // Give the agent ONLY a pointer + web-fetch ability. No MCP, no skills.
 *     // The agent is expected to fetch the index, then fetch the pages it needs.
 *     systemExtra += `\n\nCAP documentation index (llmstxt.org format): ${LLMS_TXT_URL}\n` +
 *       `Fetch this index, then fetch the specific doc pages you need via web.`
 *     // ensure a web-fetch/browse tool is enabled for this arm
 *   }
 *   // e.g. Claude Agent SDK, `claude -p`, opencode headless run, ...
 *   //   - set cwd = ws
 *   //   - register mcpServers
 *   //   - prepend systemExtra to the system prompt (or load as a skills plugin)
 *   //   - enable web fetch for the `llms-txt` arm
 *   //   - send task.prompt, run to completion
 *   //   - capture transcript + usage
 */
async function runAgent(task, arm, ws) {
  void loadSkillsContext // referenced in the sketch above
  void LLMS_TXT_URL // referenced in the sketch above
  throw new Error(
    `runAgent not wired up. Configure your agent runtime for arm ` +
      `{ mcp:${arm.mcp}, skills:${arm.skills}, llmsTxt:${arm.llmsTxt} } in ${path.relative(process.cwd(), __filename)}. ` +
      `Workspace: ${ws}`
  )
}

/** Concatenate capire/skills SKILL.md files for the `skills` arms. */
async function loadSkillsContext() {
  const skillsRoot = path.join(SKILLS_DIR, 'skills')
  let out = ''
  for (const d of await fs.readdir(skillsRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const md = path.join(skillsRoot, d.name, 'SKILL.md')
    out += `\n\n<!-- skill: ${d.name} -->\n` + (await fs.readFile(md, 'utf-8').catch(() => ''))
  }
  return out
}

/** Run one assertion against the finished workspace + transcript. Returns bool. */
async function checkAssertion(a, ws, transcript) {
  try {
    if (a.type === 'run') {
      const [cmd, ...args] = a.cmd.split(' ')
      await execFileP(cmd, args, { cwd: ws, timeout: 120_000, shell: true })
      return true
    }
    if (a.type === 'contains' || a.type === 'absent') {
      const hay = a.transcript ? transcript : await readGlob(ws, a.glob)
      const found = new RegExp(a.pattern, a.flags || 'i').test(hay)
      return a.type === 'contains' ? found : !found
    }
    if (a.type === 'llm-judge') {
      // TODO(you): call an LLM judge with a.rubric against transcript/workspace.
      return null // null = not evaluated (excluded from pass rate until wired)
    }
  } catch {
    return false
  }
  return false
}

async function readGlob(ws, glob) {
  // minimal glob: read all files, filter by simple suffix/dir hints in `glob`
  const files = []
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else files.push(p)
    }
  }
  await walk(ws)
  const ext = glob?.split('.').pop()
  const wanted = ext ? files.filter(f => f.endsWith('.' + ext)) : files
  return (await Promise.all(wanted.map(f => fs.readFile(f, 'utf-8').catch(() => '')))).join('\n')
}

async function runOne(task, armName, rep) {
  const arm = ARM_CONFIG[armName]
  const ws = await makeWorkspace(task)
  try {
    const agent = await runAgent(task, arm, ws)
    const results = []
    for (const a of task.assertions) {
      results.push({ id: a.id, pass: await checkAssertion(a, ws, agent.transcript) })
    }
    const evaluated = results.filter(r => r.pass !== null)
    const pass = evaluated.length > 0 && evaluated.every(r => r.pass)
    const usage = normalizeUsage(agent.tokens)
    const cost = costUSD(usage, agent.model)
    return { task: task.id, arm: armName, rep, pass, assertions: results, ...agent, usage, cost, ws }
  } catch (err) {
    return { task: task.id, arm: armName, rep, pass: false, error: err.message, ws }
  }
}

function aggregate(rows) {
  const arms = [...new Set(rows.map(r => r.arm))]
  const tasks = [...new Set(rows.map(r => r.task))]
  const rate = (t, a) => {
    const rs = rows.filter(r => r.task === t && r.arm === a)
    return rs.length ? rs.filter(r => r.pass).length / rs.length : 0
  }
  /* eslint-disable no-console */
  console.log('\n=== Pass-rate matrix (task × arm) ===')
  const header = 'task'.padEnd(24) + arms.map(a => a.padEnd(12)).join('')
  console.log(header)
  for (const t of tasks) {
    console.log(t.padEnd(24) + arms.map(a => rate(t, a).toFixed(2).padEnd(12)).join(''))
  }
  console.log('OVERALL'.padEnd(24) + arms.map(a => (
    rows.filter(r => r.arm === a && r.pass).length / rows.filter(r => r.arm === a).length || 0
  ).toFixed(2).padEnd(12)).join(''))

  console.log('\n=== Token consumption & cost per arm ===')
  console.log(
    '  ' +
      'arm'.padEnd(12) +
      'in'.padStart(9) +
      'out'.padStart(9) +
      'cache'.padStart(9) +
      'tool'.padStart(9) +
      'total'.padStart(9) +
      '$/run'.padStart(9) +
      '$/success'.padStart(12) +
      'turns'.padStart(7)
  )
  for (const a of arms) {
    const rs = rows.filter(r => r.arm === a && r.usage)
    if (!rs.length) continue
    const n = rs.length
    const avg = sel => rs.reduce((s, r) => s + sel(r), 0) / n
    const inTok = avg(r => r.usage.input)
    const outTok = avg(r => r.usage.output)
    const cacheTok = avg(r => r.usage.cacheRead + r.usage.cacheWrite)
    const toolTok = avg(r => r.usage.toolResult)
    const totTok = avg(r => totalTokens(r.usage))
    const costPerRun = avg(r => r.cost)
    const passes = rs.filter(r => r.pass).length
    // cost per SUCCESS: total spend on this arm ÷ number of successes.
    // The honest efficiency metric — an arm can cost more per run yet less per outcome.
    const totalCost = rs.reduce((s, r) => s + r.cost, 0)
    const costPerSuccess = passes ? totalCost / passes : Infinity
    const turns = avg(r => r.turns || 0)
    console.log(
      '  ' +
        a.padEnd(12) +
        Math.round(inTok).toString().padStart(9) +
        Math.round(outTok).toString().padStart(9) +
        Math.round(cacheTok).toString().padStart(9) +
        Math.round(toolTok).toString().padStart(9) +
        Math.round(totTok).toString().padStart(9) +
        costPerRun.toFixed(4).padStart(9) +
        (costPerSuccess === Infinity ? '∞' : costPerSuccess.toFixed(4)).padStart(12) +
        turns.toFixed(1).padStart(7)
    )
  }
  console.log(
    '\n  cache = cacheRead+cacheWrite · tool = tokens from tool results (MCP arms) · ' +
      '$/success = total arm spend ÷ successes'
  )
}

async function main() {
  const arms = (arg('arms', 'none,llms-txt,skills,mcp,mcp+skills')).split(',')
  const reps = Number(arg('reps', 3))
  const taskFilter = arg('tasks')?.split(',')
  const tasks = await loadTasks(taskFilter)

  if (!tasks.length) {
    console.error(`No tasks found in ${TASKS_DIR}. Author some (see e2e/README.md).`)
    process.exit(1)
  }

  const rows = []
  for (const task of tasks) {
    for (const armName of arms) {
      for (let rep = 0; rep < reps; rep++) {
        console.log(`▶ ${task.id} | ${armName} | rep ${rep + 1}/${reps}`)
        rows.push(await runOne(task, armName, rep))
      }
    }
  }

  aggregate(rows)

  const stamp = arg('stamp', 'latest') // pass a timestamp from the caller; Date.now() avoided for determinism
  const outDir = path.join(__dirname, 'results', stamp)
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(path.join(outDir, 'matrix.json'), JSON.stringify(rows, null, 2))
  console.log(`\nWrote ${path.relative(process.cwd(), path.join(outDir, 'matrix.json'))}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
