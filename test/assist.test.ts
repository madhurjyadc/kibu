import { test, describe, beforeEach, afterEach } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import assert from 'node:assert/strict'

import { readTime, stripTime, describeTime } from '../src/runtime/when.js'
import { reminderTitle, eventTitle, readSetting, agendaRange, noteFromWords, freeSlotQuery, freeGaps } from '../src/runtime/workflows/assist.js'
import { understand, routeFor } from '../src/runtime/model/understand.js'
import { Jev, localPlanSetup } from '../src/runtime/model/jev.js'
import { ClaudeCodePlanner } from '../src/runtime/model/claude-code-planner.js'
import { SCRIPTS, setMacBridge, osascriptBridge, reverseMacChange, explainScriptError, type MacBridge } from '../src/os/macos/scripting.js'
import { macTools, noteHtml } from '../src/runtime/tools/mac.js'
import { TaskRunner, type RunnerDeps } from '../src/runtime/loop/task-runner.js'
import type { PlannerLike, PlannerProposal } from '../src/runtime/model/planner.js'
import { ToolRegistry } from '../src/runtime/tools/registry.js'
import { fileTools } from '../src/runtime/tools/files.js'
import { userTools } from '../src/runtime/tools/user.js'
import { desktopTools } from '../src/runtime/tools/desktop.js'
import { shellTools } from '../src/runtime/tools/shell.js'
import { defaultLimits, emptyAuthorization, type TaskState } from '../src/shared/types.js'
import { DEFAULT_MODEL_CONFIG } from '../src/shared/protocol.js'

// Friday 25 September 2026, 14:00 local time.
const NOW = new Date(2026, 8, 25, 14, 0, 0)
const at = (d: Date): string => `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`

describe('reading times', () => {
  test('tomorrow at 5pm', () => {
    const r = readTime('call the bank tomorrow at 5pm', NOW)!
    assert.deepEqual(r.candidates.map(at), ['9/26 17:00'])
    assert.equal(r.dateOnly, false)
  })

  test('a bare hour gives both readings, the likely one first', () => {
    const r = readTime('tomorrow at 5', NOW)!
    assert.deepEqual(r.candidates.map(at), ['9/26 17:00', '9/26 5:00'])
    assert.deepEqual(readTime('call mom tomorrow at 7', NOW)!.candidates.map(at), ['9/26 19:00', '9/26 7:00'])
    const nine = readTime('tomorrow at 9', NOW)!
    assert.deepEqual(nine.candidates.map(at), ['9/26 9:00', '9/26 21:00'])
  })

  test('a time with no day that has passed means tomorrow', () => {
    assert.deepEqual(readTime('at 10am', NOW)!.candidates.map(at), ['9/26 10:00'])
    assert.deepEqual(readTime('at 4pm', NOW)!.candidates.map(at), ['9/25 16:00'])
  })

  test('relative times, weekdays, parts of the day and dates', () => {
    assert.deepEqual(readTime('in 20 minutes', NOW)!.candidates.map(at), ['9/25 14:20'])
    assert.deepEqual(readTime('in an hour', NOW)!.candidates.map(at), ['9/25 15:00'])
    assert.deepEqual(readTime('saturday 10am', NOW)!.candidates.map(at), ['9/26 10:00'])
    assert.deepEqual(readTime('next thursday at 3pm', NOW)!.candidates.map(at), ['10/1 15:00'])
    // Said on a Friday: later today is today, earlier today is next week.
    assert.deepEqual(readTime('friday at 6pm', NOW)!.candidates.map(at), ['9/25 18:00'])
    assert.deepEqual(readTime('friday 10am', NOW)!.candidates.map(at), ['10/2 10:00'])
    assert.deepEqual(readTime('tonight', NOW)!.candidates.map(at), ['9/25 20:00'])
    assert.deepEqual(readTime('tomorrow morning', NOW)!.candidates.map(at), ['9/26 9:00'])
    const date = readTime('on oct 3rd', NOW)!
    assert.deepEqual(date.candidates.map(at), ['10/3 0:00'])
    assert.equal(date.dateOnly, true)
  })

  test('durations are read separately', () => {
    const r = readTime('friday 3pm for 30 minutes', NOW)!
    assert.equal(r.durationMin, 30)
    assert.equal(readTime('tomorrow 2pm for 2 hours', NOW)!.durationMin, 120)
  })

  test('numbers that are not times are left alone', () => {
    assert.equal(readTime('buy 3 apples', NOW), null)
    assert.equal(readTime('email the team', NOW), null)
  })

  test('stripping the time out of a sentence', () => {
    const text = 'call the bank tomorrow at 5pm'
    assert.equal(stripTime(text, readTime(text, NOW)), 'call the bank')
  })

  test('describing a time back', () => {
    assert.equal(describeTime(new Date(2026, 8, 26, 17, 0), false, NOW), 'tomorrow at 5:00 pm')
    assert.equal(describeTime(new Date(2026, 8, 25, 0, 0), true, NOW), 'today')
  })
})

describe('reading requests', () => {
  test('reminder titles come from the user\'s own words', () => {
    const t = (s: string): string => reminderTitle(s, readTime(s, NOW))
    assert.equal(t('remind me to call the bank tomorrow at 5pm'), 'Call the bank')
    assert.equal(t('remind me in 20 minutes to stretch'), 'Stretch')
    assert.equal(t('hey kibu, remind me about the dentist on friday'), 'The dentist')
    assert.equal(t('add milk to my reminders'), 'Milk')
    assert.equal(t('add oat milk to my groceries reminders'), 'Oat milk')
    assert.equal(t('remind me to water the plants when I get home'), 'Water the plants when I get home')
  })

  test('event titles', () => {
    const t = (s: string): string => eventTitle(s, readTime(s, NOW))
    assert.equal(t('schedule a call with Priya tomorrow at 3pm'), 'Call with Priya')
    assert.equal(t('put dentist on my calendar friday 10am'), 'Dentist')
    assert.equal(t('add lunch with Sam to my calendar on friday at 1pm'), 'Lunch with Sam')
    assert.equal(t('block out focus time tomorrow 9am for 2 hours'), 'Focus time')
    assert.equal(t('schedule a call with Priya tomorrow at 3pm on my Home calendar'), 'Call with Priya')
  })

  test('settings', () => {
    assert.deepEqual(readSetting('turn on dark mode')?.input, { dark: true })
    assert.deepEqual(readSetting('switch to light mode')?.input, { dark: false })
    assert.deepEqual(readSetting('turn off dark mode')?.input, { dark: false })
    assert.deepEqual(readSetting('mute')?.input, { muted: true })
    assert.deepEqual(readSetting('unmute please')?.input, { muted: false })
    assert.deepEqual(readSetting('set volume to 30')?.input, { volume: 30, muted: false })
    assert.deepEqual(readSetting('a bit louder', 40)?.input, { volume: 55, muted: false })
    assert.equal(readSetting('find my resume'), null)
  })

  test('agenda ranges', () => {
    assert.equal(agendaRange("what's on my calendar tomorrow", NOW).label, 'tomorrow')
    assert.equal(agendaRange("what's on my calendar", NOW).label, 'today')
    const free = agendaRange('am i free at 3pm', NOW)
    assert.equal(at(free.probe!), '9/25 15:00')
    assert.equal(agendaRange("how does my week look", NOW).label, 'this week')
  })

  test('free slots between meetings', () => {
    const q = freeSlotQuery('when is my first free hour tomorrow between 9am and 6pm', NOW)
    assert.equal(at(q.windowStart), '9/26 9:00')
    assert.equal(at(q.windowEnd), '9/26 18:00')
    const ev = (h1: number, m1: number, h2: number, m2: number) => ({ start: new Date(2026, 8, 26, h1, m1).toISOString(), end: new Date(2026, 8, 26, h2, m2).toISOString(), allDay: false })
    const gaps = freeGaps(q, [ev(9, 0, 10, 30), ev(10, 30, 11, 0), ev(11, 30, 13, 0)])
    assert.deepEqual(gaps.map((g) => `${at(g.start)}-${at(g.end)}`), ['9/26 13:00-9/26 18:00'])
    const half = freeSlotQuery('find me a free half hour tomorrow', NOW)
    assert.equal(half.minutes, 30)
    assert.deepEqual(freeGaps(half, [ev(9, 0, 10, 30), ev(10, 30, 11, 0), ev(11, 30, 13, 0)]).map((g) => at(g.start)), ['9/26 11:00', '9/26 13:00'])
    // Today, the window starts from now.
    assert.equal(at(freeSlotQuery('when am i free today', NOW).windowStart), '9/25 14:30')
  })

  test('notes from words, or null when "this" means the screen', () => {
    assert.deepEqual(noteFromWords('note: pick up the dry cleaning'), { title: 'Pick up the dry cleaning', body: '' })
    assert.equal(noteFromWords('save this to notes'), null)
  })

  test('app requests are read as assist, before the web', async () => {
    const jev = new Jev(null, false)
    for (const request of ['remind me to check youtube tonight', "what's on my calendar tomorrow", 'turn on dark mode', 'run my focus shortcut', 'note: buy stamps']) {
      const read = await understand(request, jev, false)
      assert.equal(read.action, 'assist', request)
      assert.equal(routeFor(read).route, 'apps', request)
    }
  })
})

describe('getting the planner ready', () => {
  test('keywords pick the tool families and what to fetch', () => {
    const s = localPlanSetup('summarize this page into a note', 'unclear', false)
    assert.ok(s.families.includes('notes'))
    assert.equal(s.context.tab, true)
    assert.equal(s.context.clipboard, false)
    assert.equal(s.quick, true)
  })

  test('"the page I have open" fetches the tab up front', () => {
    assert.equal(localPlanSetup('save the title and link of the page I have open as a note', 'unclear', false).context.tab, true)
    assert.equal(localPlanSetup('open a new page in notes', 'unclear', false).context.tab, false)
  })

  test('the clipboard is only read when the words point at it', () => {
    assert.equal(localPlanSetup('email this to sam', 'unclear', false).context.clipboard, false)
    assert.equal(localPlanSetup('turn what I copied into a reminder', 'unclear', false).context.clipboard, true)
  })

  test('long, multi-step requests use the full model', () => {
    assert.equal(localPlanSetup('find the invoice from acme, then email it to the accountant and add a reminder to follow up', 'mixed', false).quick, false)
  })

  test('without Jev, planSetup is the keyword reading', async () => {
    const s = await new Jev(null, false).planSetup('add dentist to my calendar', 'apps', false)
    assert.equal(s.source, 'local')
    assert.ok(s.families.includes('calendar'))
  })
})

describe('Claude Code planner tiers and growing menus', () => {
  const TOOLS = [
    { name: 'notes_create', description: 'make a note', input_schema: {} },
    { name: 'finish', description: 'finish', input_schema: {} }
  ]
  const task = { request: 'x', authorization: emptyAuthorization() } as TaskState

  test('quick uses haiku, full goes back to the configured model', async () => {
    const seen: string[][] = []
    const planner = new ClaudeCodePlanner({
      model: 'sonnet',
      run: async (args) => { seen.push(args); return JSON.stringify({ session_id: 's', result: '{"text":"ok","calls":[]}' }) }
    })
    planner.seed(task, [])
    planner.setTier('quick')
    await planner.propose(TOOLS)
    planner.setTier('full')
    await planner.propose(TOOLS)
    assert.equal(seen[0]![seen[0]!.indexOf('--model') + 1], 'haiku')
    assert.equal(seen[1]![seen[1]!.indexOf('--model') + 1], 'sonnet')
  })

  test('tools added mid-task are described once', async () => {
    const prompts: string[] = []
    const planner = new ClaudeCodePlanner({
      run: async (_args, input) => { prompts.push(input); return JSON.stringify({ session_id: 's', result: '{"text":"ok","calls":[]}' }) }
    })
    planner.seed(task, [])
    await planner.propose(TOOLS)
    await planner.propose([...TOOLS, { name: 'desktop_click', description: 'click', input_schema: {} }])
    await planner.propose([...TOOLS, { name: 'desktop_click', description: 'click', input_schema: {} }])
    assert.match(prompts[1]!, /More tools are now available:[\s\S]*desktop_click/)
    assert.doesNotMatch(prompts[1]!, /notes_create/)
    assert.doesNotMatch(prompts[2]!, /desktop_click/)
  })
})

/* ------------------------------------------------------------------ *
 * A fake Mac: app state in memory, answering the same scripts.
 * ------------------------------------------------------------------ */

interface FakeMac extends MacBridge {
  events: { id: string; title: string; start: string; end: string; calendar: string }[]
  reminders: { id: string; title: string; due?: string; list: string }[]
  notes: { id: string; html: string }[]
  dark: boolean
  calls: string[]
}

function fakeMac(): FakeMac {
  const name = (body: string): string => Object.entries(SCRIPTS).find(([, s]) => s === body)?.[0] ?? 'unknown'
  let n = 0
  const mac: FakeMac = {
    events: [], reminders: [], notes: [], dark: false, calls: [],
    async jxa<T>(body: string, input: any): Promise<T> {
      const script = name(body)
      mac.calls.push(script)
      const out = ((): unknown => {
        switch (script) {
          case 'calendars': return [{ name: 'Work', writable: true }, { name: 'Home', writable: true }, { name: 'Holidays', writable: false }]
          case 'events': return mac.events.filter((e) => e.start < input.to && e.end > input.from).map((e) => ({ ...e, allDay: false, location: '' }))
          case 'createEvent': { const id = `ev${++n}`; mac.events.push({ id, title: input.title, start: input.start, end: input.end, calendar: input.calendar ?? 'Work' }); return { id, calendar: input.calendar ?? 'Work' } }
          case 'eventExists': return { found: mac.events.some((e) => e.id === input.id) }
          case 'deleteEvent': { const before = mac.events.length; mac.events = mac.events.filter((e) => e.id !== input.id); return { deleted: mac.events.length < before } }
          case 'reminderLists': return ['Reminders', 'Groceries']
          case 'createReminder': { const id = `r${++n}`; mac.reminders.push({ id, title: input.title, due: input.due, list: input.list ?? 'Reminders' }); return { id, list: input.list ?? 'Reminders' } }
          case 'reminderExists': return { found: mac.reminders.some((r) => r.id === input.id) }
          case 'deleteReminder': { const before = mac.reminders.length; mac.reminders = mac.reminders.filter((r) => r.id !== input.id); return { deleted: mac.reminders.length < before } }
          case 'createNote': { const id = `note${++n}`; mac.notes.push({ id, html: input.html }); return { id, name: 'x', folder: 'Notes' } }
          case 'noteExists': return { found: mac.notes.some((x) => x.id === input.id) }
          case 'readNote': throw new Error('Notes couldn\'t find what was asked for.')
          case 'appearance': { const previous = mac.dark; if (typeof input.dark === 'boolean') mac.dark = input.dark; return { previous, now: mac.dark } }
          default: throw new Error(`fake mac has no script ${script}`)
        }
      })()
      return out as T
    },
    async exec() { return { stdout: '', stderr: 'not in tests', code: 1 } }
  }
  return mac
}

class ScriptedPlanner implements PlannerLike {
  public menus: string[][] = []
  public tiers: string[] = []
  public notes: string[] = []
  private turn = 0
  constructor(private readonly script: { name: string; input: unknown }[][]) {}
  seed(): void {}
  addToolResults(): void {}
  addNote(note: string): void { this.notes.push(note) }
  setTier(tier: 'quick' | 'full'): void { this.tiers.push(tier) }
  async propose(tools: { name: string }[]): Promise<PlannerProposal> {
    this.menus.push(tools.map((t) => t.name))
    const calls = this.script[this.turn++] ?? []
    return {
      calls: calls.map((c, i) => ({ id: `c${this.turn}-${i}`, name: c.name, input: c.input })),
      text: calls.length ? '' : 'done', stopReason: calls.length ? 'tool_use' : 'end_turn', usd: 0, inputTokens: 1, outputTokens: 1
    }
  }
}

const registry = new ToolRegistry()
registry.registerAll([...fileTools, ...userTools, ...desktopTools, ...shellTools, ...macTools])

function run(request: string, opts: { workflows?: boolean; planner?: ScriptedPlanner } = {}): Promise<TaskState> {
  const auth = emptyAuthorization()
  auth.capabilities = ['user.interact', 'files.read']
  const task: TaskState = {
    id: `t-${Math.random().toString(36).slice(2)}`, request, outcome: '', status: 'pending', petState: 'idle', authorization: auth,
    limits: defaultLimits(), observations: [], plan: [], actions: [], cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    completionCriteria: [], statusLine: '', createdAt: Date.now(), updatedAt: Date.now()
  }
  const deps: RunnerDeps = {
    os: { supports: () => false, listApps: async () => [], listDisplays: async () => [] } as unknown as RunnerDeps['os'],
    browser: { isOpen: () => false, close: async () => {}, page: async () => { throw new Error('no browser') } } as unknown as RunnerDeps['browser'],
    registry, model: DEFAULT_MODEL_CONFIG, apiKey: null, jevEnabled: false, jevApiKey: null,
    workflowsEnabled: opts.workflows ?? true, droppedPaths: [], frontWindow: null, previousTurn: null, confirmEveryAction: false,
    previousApp: 'Safari',
    ...(opts.planner ? { createPlanner: () => opts.planner! } : {})
  }
  let runner: TaskRunner
  runner = new TaskRunner(task, deps, {
    onUpdate: (t) => { if (t.question) { const q = t.question; queueMicrotask(() => runner.answer({ questionId: q.id, optionId: q.options?.[0]?.id ?? null, text: 'try again' })) } },
    onPetState: () => {}, onLog: () => {}, claimDesktop: async () => {}, releaseDesktop: () => {}
  })
  return runner.run()
}

describe('app workflows run end to end with no planning model', () => {
  let mac: FakeMac
  beforeEach(() => { mac = fakeMac(); setMacBridge(mac) })
  afterEach(() => setMacBridge(osascriptBridge))

  test('a reminder, at the time asked for, undoable', async () => {
    const t = await run('remind me to call the bank tomorrow at 5pm')
    assert.equal(t.status, 'succeeded', t.summary?.headline)
    assert.equal(mac.reminders.length, 1)
    assert.equal(mac.reminders[0]!.title, 'Call the bank')
    const due = new Date(mac.reminders[0]!.due!)
    assert.equal(due.getHours(), 17)
    assert.equal(t.summary?.undoable, true)
    assert.match(t.summary!.headline, /Call the bank tomorrow at 5:00 pm|Call the bank .* at 5:00 pm/)
    // Verified by reading Reminders back, not by trusting the create call.
    assert.ok(mac.calls.includes('reminderExists'))
  })

  test('a list the user names is used', async () => {
    await run('add oat milk to my groceries reminders')
    assert.equal(mac.reminders[0]!.list, 'Groceries')
  })

  test('an event goes on the calendar the user names, with a clash warning', async () => {
    const start = new Date(); start.setDate(start.getDate() + 1); start.setHours(15, 0, 0, 0)
    const end = new Date(start.getTime() + 60 * 60_000)
    mac.events.push({ id: 'old', title: 'Standup', start: start.toISOString(), end: end.toISOString(), calendar: 'Work' })
    const t = await run('schedule a call with Priya tomorrow at 3pm on my Home calendar')
    assert.equal(t.status, 'succeeded', t.summary?.headline)
    const made = mac.events.find((e) => e.id !== 'old')!
    assert.equal(made.title, 'Call with Priya')
    assert.equal(made.calendar, 'Home')
    assert.match(t.summary!.headline, /overlaps "Standup"/)
  })

  test('dark mode, undoable back to light', async () => {
    const t = await run('turn on dark mode')
    assert.equal(t.status, 'succeeded')
    assert.equal(mac.dark, true)
    const undo = t.actions.find((a) => a.undo)!.undo!
    assert.deepEqual(undo, { kind: 'mac.setting', payload: { from: 'dark', to: 'false' } })
    const r = await reverseMacChange(undo.kind as 'mac.setting', undo.payload, mac)
    assert.deepEqual(r, { ok: true })
    assert.equal(mac.dark, false)
  })

  test('a note from what the user said', async () => {
    const t = await run('note: the wifi password is on the fridge')
    assert.equal(t.status, 'succeeded')
    assert.match(mac.notes[0]!.html, /<h1>The wifi password is on the fridge<\/h1>/)
  })

  test('undoing an event removes it; undoing twice says it is gone', async () => {
    await run('put dentist on my calendar friday 10am')
    const id = mac.events[0]!.id
    assert.deepEqual(await reverseMacChange('mac.event', { from: 'Calendar', to: id }, mac), { ok: true })
    assert.deepEqual(await reverseMacChange('mac.event', { from: 'Calendar', to: id }, mac), { ok: false, reason: 'the event is already gone' })
  })
})

describe('the planner path', () => {
  let mac: FakeMac
  beforeEach(() => { mac = fakeMac(); setMacBridge(mac) })
  afterEach(() => setMacBridge(osascriptBridge))

  test('is shown only the tools the request needs, and the quick model', async () => {
    const planner = new ScriptedPlanner([[{ name: 'notes_create', input: { title: 'Summary', body: 'short' } }], []])
    const t = await run('summarize this page into a note', { workflows: false, planner })
    assert.equal(t.status, 'succeeded', t.summary?.headline)
    const menu = planner.menus[0]!
    assert.ok(menu.includes('notes_create'))
    assert.ok(menu.includes('context_now'))
    assert.ok(menu.includes('ask_user'))
    assert.ok(!menu.includes('desktop_click'), 'no mouse-clicking for a note')
    assert.ok(!menu.includes('files_move'))
    assert.deepEqual(planner.tiers, ['quick'])
    assert.ok(planner.notes.some((n) => /The user was in Safari/.test(n)))
  })

  test('widens to every tool and the full model once the work stalls', async () => {
    const bad = { name: 'notes_read', input: { id: 'missing' } }
    const planner = new ScriptedPlanner([[bad], [bad], [bad], [bad], [], []])
    await run('read my note about the trip', { workflows: false, planner })
    assert.ok(!planner.menus[0]!.includes('desktop_click'))
    assert.ok(planner.menus.at(-1)!.includes('desktop_click'), 'the menu grew')
    assert.deepEqual(planner.tiers, ['quick', 'full'])
  })
})

describe('the persistent Claude Code session', () => {
  /** A stand-in for the CLI: answers each stream-json message with a result line. */
  function fakeCli(onMessage: (text: string, n: number) => string) {
    const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    let n = 0
    const spawnProcess = (_bin: string, args: string[], env: NodeJS.ProcessEnv) => {
      spawned.push({ args, env })
      const child = new EventEmitter() as any
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.exitCode = null
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0) }
      child.stdin.on('data', (chunk: Buffer) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const text = JSON.parse(line).message.content
          const result = onMessage(text, ++n)
          child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n')
          child.stdout.write(JSON.stringify({ type: 'result', session_id: 'sess', result, usage: { input_tokens: 5, output_tokens: 2 } }) + '\n')
        }
      })
      return child
    }
    return { spawned, spawnProcess }
  }
  const TOOLS = [{ name: 'finish', description: 'finish', input_schema: {} }]
  const task = { request: 'x', authorization: emptyAuthorization() } as TaskState

  test('one process serves every step, and the quick model thinks less', async () => {
    const cli = fakeCli((_t, n) => `{"text":"step ${n}","calls":[]}`)
    const planner = new ClaudeCodePlanner({ bin: 'claude', spawnProcess: cli.spawnProcess })
    planner.seed(task, [])
    planner.setTier('quick')
    assert.equal((await planner.propose(TOOLS)).text, 'step 1')
    assert.equal((await planner.propose(TOOLS)).text, 'step 2')
    assert.equal(cli.spawned.length, 1)
    assert.ok(cli.spawned[0]!.args.includes('stream-json'))
    assert.equal(cli.spawned[0]!.env.MAX_THINKING_TOKENS, '0')
    planner.dispose()
  })

  test('changing tier restarts on the same conversation', async () => {
    const cli = fakeCli((_t, n) => `{"text":"step ${n}","calls":[]}`)
    const planner = new ClaudeCodePlanner({ bin: 'claude', model: 'sonnet', spawnProcess: cli.spawnProcess })
    planner.seed(task, [])
    planner.setTier('quick')
    await planner.propose(TOOLS)
    planner.setTier('full')
    await planner.propose(TOOLS)
    assert.equal(cli.spawned.length, 2)
    const second = cli.spawned[1]!.args
    assert.equal(second[second.indexOf('--model') + 1], 'sonnet')
    assert.equal(second[second.indexOf('--resume') + 1], 'sess')
    assert.equal(cli.spawned[1]!.env.MAX_THINKING_TOKENS, undefined)
    planner.dispose()
  })

  test('a process that dies fails the step instead of hanging', async () => {
    const cli = fakeCli(() => '')
    const planner = new ClaudeCodePlanner({
      bin: 'claude',
      spawnProcess: (b, a, e) => {
        const child = cli.spawnProcess(b, a, e)
        child.stdin!.removeAllListeners('data')
        child.stdin!.on('data', () => { (child.stderr as PassThrough).write('not logged in'); child.emit('exit', 1) })
        return child
      }
    })
    planner.seed(task, [])
    await assert.rejects(() => planner.propose(TOOLS), /not logged in/)
  })
})

describe('small details', () => {
  test('permission errors say where to fix them', () => {
    assert.match(explainScriptError('execution error: Not authorized to send Apple events to Calendar. (-1743)', 'Calendar'), /Privacy & Security → Automation/)
  })

  test('note bodies are escaped', () => {
    assert.equal(noteHtml('<b>hi</b>', 'a & b'), '<div><h1>&lt;b&gt;hi&lt;/b&gt;</h1></div><div>a &amp; b</div>')
  })
})
