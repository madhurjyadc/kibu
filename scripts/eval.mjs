/**
 * Runs real requests through the real task runner, on this Mac, with Claude
 * Code as the planner and Jev for the fast decisions, and reports what
 * happened: which path handled each one, how long it took, and whether it
 * worked.
 *
 * It only reads, or creates things it then removes again with Kibu's own
 * undo. Nothing is sent, deleted or moved.
 *
 *   npm run eval                    # every case
 *   npm run eval -- remind agenda   # only cases whose id contains a word
 *
 * Set TYPESAFE_API_KEY to use Jev; without it, local rules stand in, and the
 * report says so. Needs Claude Code installed and signed in.
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TaskRunner } from '../dist-test/src/runtime/loop/task-runner.js'
import { ToolRegistry } from '../dist-test/src/runtime/tools/registry.js'
import { fileTools } from '../dist-test/src/runtime/tools/files.js'
import { shellTools } from '../dist-test/src/runtime/tools/shell.js'
import { userTools } from '../dist-test/src/runtime/tools/user.js'
import { desktopTools } from '../dist-test/src/runtime/tools/desktop.js'
import { browserTools, ManagedBrowser } from '../dist-test/src/runtime/tools/browser.js'
import { macTools } from '../dist-test/src/runtime/tools/mac.js'
import { ClaudeCodePlanner } from '../dist-test/src/runtime/model/claude-code-planner.js'
import { reverseMacChange } from '../dist-test/src/os/macos/scripting.js'
import { createOsAdapter } from '../dist-test/src/os/index.js'
import { defaultLimits, emptyAuthorization } from '../dist-test/src/shared/types.js'
import { DEFAULT_MODEL_CONFIG } from '../dist-test/src/shared/protocol.js'
import { homedir } from 'node:os'

/**
 * `path` says which way a case should be handled — a no-model workflow, or
 * the planner — so a regression that sends an easy request the slow way
 * shows up as a failure, not just a slower pass.
 */
const CASES = [
  { id: 'agenda-week', request: "what's on my calendar this week?", path: 'workflow' },
  { id: 'agenda-free', request: 'am i free tomorrow at 3pm?', path: 'workflow' },
  { id: 'remind-relative', request: 'remind me to stretch in 2 hours', path: 'workflow', expect: /stretch/i },
  { id: 'remind-ampm', request: 'remind me to call mom tomorrow at 7', path: 'workflow', expect: /call mom/i },
  { id: 'event-add', request: 'put kibu eval on my calendar saturday at 11pm for 30 minutes', path: 'workflow', expect: /kibu eval/i },
  { id: 'note-words', request: 'note: kibu eval note, safe to delete', path: 'workflow' },
  { id: 'find-file', request: 'find the biggest file in my downloads', path: 'workflow' },
  { id: 'tab-question', request: 'what is the page I have open in my browser about? one sentence.', path: 'planner' },
  { id: 'reminders-question', request: 'how many reminders do I have open, and what are they?', path: 'planner' },
  { id: 'tab-to-note', request: 'save the title and link of the page I have open as a new note', path: 'planner' },
  { id: 'calendar-gap', request: 'when is my first free hour tomorrow between 9am and 6pm?', path: 'workflow' },
  { id: 'plan-evening', request: 'look at my calendar and reminders and tell me what I should focus on tomorrow', path: 'planner' }
]

const filters = process.argv.slice(2)
const cases = filters.length ? CASES.filter((c) => filters.some((f) => c.id.includes(f))) : CASES
const jevKey = process.env.TYPESAFE_API_KEY ?? null

const registry = new ToolRegistry()
registry.registerAll([...fileTools, ...shellTools, ...userTools, ...desktopTools, ...browserTools, ...macTools])
const os = createOsAdapter(join(process.cwd(), 'resources/bin/kibu-helper'))
const browser = new ManagedBrowser(join(homedir(), 'Library/Application Support/kibu/browser-profile-eval'), join(process.cwd(), 'downloads'), () => {})

async function runCase(c) {
  const auth = emptyAuthorization()
  auth.capabilities = ['user.interact', 'files.read']
  // The eval grants reading the home folder up front, so it measures the
  // work rather than a permission prompt nobody is there to answer.
  auth.readRoots = [homedir()]
  const task = {
    id: randomUUID(), request: c.request, outcome: '', status: 'pending', petState: 'idle', authorization: auth,
    limits: defaultLimits(), observations: [], plan: [], actions: [], cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    completionCriteria: [], statusLine: '', createdAt: Date.now(), updatedAt: Date.now()
  }
  const logs = []
  let plannerCalls = 0
  const planner = new ClaudeCodePlanner({ model: DEFAULT_MODEL_CONFIG.claudeCode })
  const propose = planner.propose.bind(planner)
  planner.propose = async (tools) => {
    plannerCalls++
    const started = Date.now()
    const p = await propose(tools)
    logs.push({ source: 'timing', message: `planner step ${plannerCalls}: ${Date.now() - started}ms, ${tools.length} tools` })
    return p
  }
  let runner
  runner = new TaskRunner(task, {
    os, browser, registry, model: DEFAULT_MODEL_CONFIG, apiKey: null,
    jevEnabled: true, jevApiKey: jevKey, workflowsEnabled: true, droppedPaths: [],
    frontWindow: null, previousApp: 'Google Chrome', prefetchContext: true, previousTurn: null, confirmEveryAction: false,
    createPlanner: () => planner
  }, {
    // Nobody is at the keyboard: a question ends the case, and is reported.
    onUpdate: (t) => { if (t.question) { const q = t.question; logs.push({ source: 'question', message: q.prompt }); queueMicrotask(() => runner.answer({ questionId: q.id, optionId: q.options?.find((o) => /allow|yes|use/i.test(o.label))?.id ?? null, text: 'you decide' })) } },
    onPetState: () => {}, onLog: (e) => logs.push(e), claimDesktop: async () => {}, releaseDesktop: () => {}
  })
  const started = Date.now()
  const done = await runner.run()
  const ms = Date.now() - started

  // Put back anything the case created.
  let undone = 0
  for (const a of done.actions) {
    if (a.undo?.kind?.startsWith('mac.')) { const r = await reverseMacChange(a.undo.kind, a.undo.payload); if (r.ok) undone++ }
  }

  const path = plannerCalls > 0 ? 'planner' : 'workflow'
  const headline = done.summary?.headline ?? done.error ?? ''
  const problems = []
  if (done.status !== 'succeeded') problems.push(`status ${done.status}`)
  if (path !== c.path) problems.push(`went the ${path} way, expected ${c.path}`)
  if (c.expect && !c.expect.test(JSON.stringify(done.actions.map((a) => a.input)))) problems.push('did not act on the right thing')
  const jev = logs.filter((l) => l.source === 'jev').map((l) => l.message)
  return { c, ms, path, plannerCalls, headline, problems, undone, jev, timing: logs.filter((l) => l.source === 'timing').map((l) => l.message), questions: logs.filter((l) => l.source === 'question').map((l) => l.message) }
}

console.log(`Kibu eval — ${cases.length} cases, planner: Claude Code (${DEFAULT_MODEL_CONFIG.claudeCode}), Jev: ${jevKey ? 'on' : 'off (local rules)'}\n`)
const results = []
for (const c of cases) {
  process.stdout.write(`… ${c.id}`)
  const r = await runCase(c).catch((err) => ({ c, ms: 0, path: '?', plannerCalls: 0, headline: String(err?.message ?? err), problems: ['crashed'], undone: 0, jev: [], timing: [], questions: [] }))
  results.push(r)
  const mark = r.problems.length ? '✗' : '✓'
  process.stdout.write(`\r${mark} ${c.id.padEnd(20)} ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.path.padEnd(8)} ${r.plannerCalls ? `${r.plannerCalls} steps` : ''}\n`)
  console.log(`    ${r.headline.replace(/\s+/g, ' ').slice(0, 160)}`)
  for (const p of r.problems) console.log(`    ! ${p}`)
  for (const q of r.questions) console.log(`    ? asked: ${q.replace(/\s+/g, ' ').slice(0, 120)}`)
  for (const t of r.timing) console.log(`    · ${t}`)
  const setup = r.jev.find((m) => /offering|widening/.test(m))
  if (setup) console.log(`    · ${setup}`)
  if (r.undone) console.log(`    · cleaned up ${r.undone} item${r.undone > 1 ? 's' : ''}`)
}

const passed = results.filter((r) => !r.problems.length)
const byPath = (p) => results.filter((r) => r.path === p)
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
console.log(`\n${passed.length}/${results.length} passed`)
for (const p of ['workflow', 'planner']) {
  const rs = byPath(p)
  if (rs.length) console.log(`  ${p}: ${rs.length} cases, median ${(median(rs.map((r) => r.ms)) / 1000).toFixed(1)}s`)
}
await browser.close().catch(() => {})
await os.dispose?.().catch(() => {})
process.exit(passed.length === results.length ? 0 : 1)
