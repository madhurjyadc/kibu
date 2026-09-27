import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  explicitMemory, looksSecret, makeMemory, mergeMemory, recall, suggestChoice, learnedChoice, lexicalScore, memoryNote
} from '../src/runtime/memory.js'
import { Jev } from '../src/runtime/model/jev.js'
import { Store } from '../src/main/services/db.js'
import { SCRIPTS, setMacBridge, osascriptBridge, type MacBridge } from '../src/os/macos/scripting.js'
import { macTools } from '../src/runtime/tools/mac.js'
import { rememberTool } from '../src/runtime/tools/memory.js'
import { TaskRunner, type RunnerDeps, type MemoryEvent } from '../src/runtime/loop/task-runner.js'
import type { PlannerLike, PlannerProposal } from '../src/runtime/model/planner.js'
import { ToolRegistry } from '../src/runtime/tools/registry.js'
import { fileTools } from '../src/runtime/tools/files.js'
import { userTools } from '../src/runtime/tools/user.js'
import { shellTools } from '../src/runtime/tools/shell.js'
import { defaultLimits, emptyAuthorization, type Memory, type TaskState } from '../src/shared/types.js'
import { DEFAULT_MODEL_CONFIG } from '../src/shared/protocol.js'

describe('what counts as something to remember', () => {
  test('things the user tells Kibu', () => {
    assert.deepEqual(explicitMemory('remember that my manager is Priya'), { text: 'my manager is Priya', kind: 'fact' })
    assert.deepEqual(explicitMemory('Kibu, remember: I prefer 24-hour times.'), { text: 'I prefer 24-hour times', kind: 'preference' })
    assert.deepEqual(explicitMemory("don't forget that our office wifi is KibuNet"), { text: 'our office wifi is KibuNet', kind: 'fact' })
    assert.deepEqual(explicitMemory('from now on, put invoices in Finance'), { text: 'put invoices in Finance', kind: 'preference' })
    assert.deepEqual(explicitMemory('remember my sister lives in Pune'), { text: 'my sister lives in Pune', kind: 'fact' })
  })

  test('a reminder is not a memory', () => {
    assert.equal(explicitMemory('remember to call mom tomorrow'), null)
    assert.equal(explicitMemory('make a note of the wifi password'), null)
    assert.equal(explicitMemory('tidy my downloads'), null)
  })

  test('secrets are refused, ordinary facts are not', () => {
    assert.ok(looksSecret('my bank password is hunter2'))
    assert.ok(looksSecret('the OTP is 492013'))
    assert.ok(looksSecret('my card is 4111 1111 1111 1111'))
    assert.ok(looksSecret('my aadhaar is 1234 5678 9012'))
    assert.equal(looksSecret('my manager is Priya'), null)
    assert.equal(looksSecret('my flight is AI 302 on the 4th'), null)
  })
})

describe('keeping memory tidy', () => {
  test('saying the same thing twice strengthens it instead of duplicating', () => {
    const a = makeMemory('my manager is Priya', 'fact', 'told')
    const { memory, replaces } = mergeMemory([a], makeMemory('My manager is Priya.', 'fact', 'told'))
    assert.equal(replaces, a.id)
    assert.equal(memory.evidence, 2)
  })

  test('a changed choice replaces the old one', () => {
    const work = learnedChoice('calendar', 'Work', 'standup', 'Events like "Standup" go on the Work calendar')!
    const { memory, replaces } = mergeMemory([work], learnedChoice('calendar', 'Home', 'standup', 'Events like "Standup" go on the Home calendar')!)
    assert.equal(replaces, work.id)
    assert.equal(memory.choice!.value, 'Home')
    assert.equal(memory.evidence, 1)
  })

  test('a learned choice needs a shared word, not just a topic', () => {
    const ms = [learnedChoice('calendar', 'Work', 'Standup', 'Standup goes on Work')!]
    assert.equal(suggestChoice('calendar', 'Standup', ms)?.choice?.value, 'Work')
    assert.equal(suggestChoice('calendar', 'Dentist', ms), null)
    assert.equal(suggestChoice('calendar', 'Standup', ms, ['Home']), null, 'only a calendar that still exists')
  })
})

describe('recall brings up only what helps', () => {
  const manager = makeMemory('my manager is Priya Shah', 'fact', 'told')
  const invoices = makeMemory('invoices go in ~/Documents/Finance', 'preference', 'told')
  const time = makeMemory('I prefer 24-hour times', 'preference', 'told')
  const all = [manager, invoices, time]

  test('without Jev, a shared distinctive word is required', async () => {
    const r = await recall('email my manager about the launch', all, null)
    assert.deepEqual(r.map((x) => x.memory.id), [manager.id])
    assert.deepEqual(await recall('tidy up my downloads', all, null), [])
    assert.deepEqual((await recall('file this invoice', all, null)).map((x) => x.memory.id), [invoices.id])
  })

  test('with Jev, each candidate is a yes or no, and only clear yeses come back', async () => {
    const seen: unknown[] = []
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init!.body))
      seen.push(body)
      // Jev says the time preference matters for a calendar request; the rest do not.
      const answers: Record<string, unknown> = {}
      for (const [key, q] of Object.entries(body.questions as Record<string, { question?: string; prompt?: string }>)) {
        const text = JSON.stringify(q)
        answers[key] = { type: 'noul', noul: /24-hour/.test(text) ? 0.9 : 0.1 }
      }
      return new Response(JSON.stringify({ model: 'jev-latest', answers, usage: { input_tokens: 200, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const jev = new Jev('k', true, 'jev-latest', fetchImpl as never)
    const r = await recall('when is my first meeting tomorrow?', all, jev)
    assert.deepEqual(r.map((x) => x.memory.id), [time.id])
    assert.equal(seen.length, 1, 'one call for every candidate')
  })

  test('the planner is told what to do with them', () => {
    const note = memoryNote([{ memory: manager, why: 'test' }])!
    assert.match(note, /<memory>[\s\S]*Priya Shah[\s\S]*<\/memory>/)
    assert.match(note, /do not mention it/)
    assert.equal(memoryNote([]), null)
  })

  test('scores favour names over topics', () => {
    assert.ok(lexicalScore('email priya', manager) > lexicalScore('email someone', manager))
  })
})

describe('the memory store', () => {
  test('saves, replaces, counts uses, and forgets', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'kibu-mem-')))
    const a = makeMemory('my manager is Priya', 'fact', 'told')
    store.saveMemory(a)
    const b = { ...a, id: 'new-id', text: 'My manager is Sam', updatedAt: a.updatedAt + 1 }
    store.saveMemory(b, a.id)
    assert.deepEqual(store.listMemories().map((m) => m.text), ['My manager is Sam'])
    store.markMemoriesUsed(['new-id'])
    assert.equal(store.listMemories()[0]!.uses, 1)
    store.deleteMemories(['new-id'])
    assert.equal(store.listMemories().length, 0)
    store.saveMemory(makeMemory('x y z', 'fact', 'told'))
    store.clearMemories()
    assert.equal(store.listMemories().length, 0)
    store.close()
  })
})

/* ------------------------------------------------------------------ *
 * End to end through the real runner, with a fake Mac.
 * ------------------------------------------------------------------ */

function fakeMac() {
  const events: { id: string; title: string; start: string; end: string; calendar: string }[] = []
  const name = (body: string): string => Object.entries(SCRIPTS).find(([, s]) => s === body)?.[0] ?? 'unknown'
  let n = 0
  const mac: MacBridge = {
    async jxa<T>(body: string, input: any): Promise<T> {
      switch (name(body)) {
        case 'calendars': return [{ name: 'Work', writable: true }, { name: 'Home', writable: true }] as T
        case 'events': return [] as T
        case 'createEvent': { const id = `ev${++n}`; events.push({ id, title: input.title, start: input.start, end: input.end, calendar: input.calendar }); return { id, calendar: input.calendar } as T }
        case 'eventExists': return { found: events.some((e) => e.id === input.id) } as T
        default: throw new Error(`no fake for ${name(body)}`)
      }
    },
    async exec() { return { stdout: '', stderr: '', code: 1 } }
  }
  return { mac, events }
}

class ScriptedPlanner implements PlannerLike {
  notes: string[] = []
  private turn = 0
  constructor(private readonly script: { name: string; input: unknown }[][]) {}
  seed(): void {}
  addToolResults(): void {}
  addNote(note: string): void { this.notes.push(note) }
  async propose(): Promise<PlannerProposal> {
    const calls = this.script[this.turn++] ?? []
    return { calls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, input: c.input })), text: calls.length ? '' : 'done', stopReason: calls.length ? 'tool_use' : 'end_turn', usd: 0, inputTokens: 1, outputTokens: 1 }
  }
}

const registry = new ToolRegistry()
registry.registerAll([...fileTools, ...userTools, ...shellTools, ...macTools, rememberTool])

/** A tiny host: holds memories the way main does, applying the runner's events. */
function host(initial: Memory[] = []) {
  let memories = [...initial]
  const events: MemoryEvent[] = []
  async function run(request: string, opts: { planner?: ScriptedPlanner; enabled?: boolean; learn?: boolean; answer?: string } = {}): Promise<TaskState> {
    const task: TaskState = {
      id: `t-${Math.random().toString(36).slice(2)}`, request, outcome: '', status: 'pending', petState: 'idle',
      authorization: { ...emptyAuthorization(), capabilities: ['user.interact', 'files.read'] }, limits: defaultLimits(),
      observations: [], plan: [], actions: [], cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
      completionCriteria: [], statusLine: '', createdAt: Date.now(), updatedAt: Date.now()
    }
    const deps: RunnerDeps = {
      os: { supports: () => false, listApps: async () => [], listDisplays: async () => [] } as unknown as RunnerDeps['os'],
      browser: { isOpen: () => false, close: async () => {}, page: async () => { throw new Error('no') } } as unknown as RunnerDeps['browser'],
      registry, model: DEFAULT_MODEL_CONFIG, apiKey: null, jevEnabled: false, jevApiKey: null, workflowsEnabled: true,
      droppedPaths: [], frontWindow: null, previousTurn: null, confirmEveryAction: false,
      memories, memory: { enabled: opts.enabled ?? true, learn: opts.learn ?? true },
      ...(opts.planner ? { createPlanner: () => opts.planner! } : {})
    }
    let runner: TaskRunner
    runner = new TaskRunner(task, deps, {
      onUpdate: (t) => { if (t.question) { const q = t.question; queueMicrotask(() => runner.answer({ questionId: q.id, optionId: opts.answer ?? q.options?.[0]?.id ?? null })) } },
      onPetState: () => {}, onLog: () => {}, claimDesktop: async () => {}, releaseDesktop: () => {},
      onMemory: (e) => {
        events.push(e)
        if (e.type === 'save') memories = [...memories.filter((m) => m.id !== e.replaces && m.id !== e.memory.id), e.memory]
        if (e.type === 'forget') memories = memories.filter((m) => !e.ids.includes(m.id))
      }
    })
    return runner.run()
  }
  return { run, events, get memories() { return memories } }
}

describe('memory in real tasks', () => {
  let fake: ReturnType<typeof fakeMac>
  beforeEach(() => { fake = fakeMac(); setMacBridge(fake.mac) })
  afterEach(() => setMacBridge(osascriptBridge))

  test('told, listed, and forgotten — with no model', async () => {
    const h = host()
    let t = await h.run('remember that my manager is Priya')
    assert.equal(t.status, 'succeeded')
    assert.match(t.summary!.headline, /I'll remember that/)
    assert.equal(h.memories[0]!.text, 'My manager is Priya')

    t = await h.run('what do you remember about me?')
    assert.match(t.summary!.headline, /I remember 1 thing/)
    assert.match(JSON.stringify(t.summary!.evidence), /My manager is Priya/)

    t = await h.run('forget that my manager is Priya')
    assert.equal(h.memories.length, 0)
    assert.match(t.summary!.headline, /Forgotten/)
  })

  test('a secret is refused even when asked directly', async () => {
    const h = host()
    const t = await h.run('remember that my card is 4111 1111 1111 1111')
    assert.equal(h.memories.length, 0)
    assert.match(t.summary!.headline, /don't keep card numbers/)
  })

  test('naming a calendar once teaches it; the next similar event uses it and says so', async () => {
    const h = host()
    await h.run('schedule standup tomorrow at 10am on my Home calendar')
    assert.equal(fake.events[0]!.calendar, 'Home')
    assert.equal(h.memories.length, 1)
    assert.equal(h.memories[0]!.choice?.value, 'Home')

    const t = await h.run('put standup on my calendar friday 9am')
    assert.equal(fake.events[1]!.calendar, 'Home')
    assert.match(t.summary!.headline, /like last time/)
    assert.ok(t.summary!.evidence.some((e) => e.label === 'From memory'))
    assert.ok(h.events.some((e) => e.type === 'used'))
  })

  test('an unrelated event is not affected by it', async () => {
    const h = host()
    await h.run('schedule standup tomorrow at 10am on my Home calendar')
    const t = await h.run('put dentist on my calendar friday 9am')
    assert.ok(!t.summary!.evidence.some((e) => e.label === 'From memory'))
    assert.doesNotMatch(t.summary!.headline, /like last time/)
  })

  test('with learning off, choices are not picked up — but told things still are', async () => {
    const h = host()
    await h.run('schedule standup tomorrow at 10am on my Home calendar', { learn: false })
    assert.equal(h.memories.length, 0)
    await h.run('remember that standups are at 10', { learn: false })
    assert.equal(h.memories.length, 1)
  })

  test('with memory off, nothing is kept or recalled', async () => {
    const h = host([makeMemory('my manager is Priya', 'fact', 'told')])
    const t = await h.run('remember that my sister is Mira', { enabled: false })
    assert.match(t.summary!.headline, /Memory is off/)
    const planner = new ScriptedPlanner([[{ name: 'finish', input: { success: true, headline: 'ok' } }]])
    await h.run('email my manager', { enabled: false, planner })
    assert.ok(!planner.notes.some((n) => /Priya/.test(n)))
  })

  test('the planner hears only the relevant memory, and a cited one shows in the result', async () => {
    const manager = makeMemory('my manager is Priya Shah', 'fact', 'told')
    const invoices = makeMemory('invoices go in ~/Documents/Finance', 'preference', 'told')
    const h = host([manager, invoices])
    const planner = new ScriptedPlanner([[{ name: 'finish', input: { success: true, headline: 'Drafted it to Priya.', usedMemories: [manager.id, 'made-up-id'] } }]])
    const t = await h.run('draft an email to my manager about the launch', { planner })
    const note = planner.notes.find((n) => n.includes('<memory>'))!
    assert.match(note, /Priya Shah/)
    assert.doesNotMatch(note, /Finance/)
    const from = t.summary!.evidence.filter((e) => e.label === 'From memory')
    assert.deepEqual(from.map((e) => e.value), ['My manager is Priya Shah'], 'only ids it was actually given count')
  })

  test('the planner can keep a stated preference, but not a secret', async () => {
    const h = host()
    const planner = new ScriptedPlanner([
      [{ name: 'remember', input: { text: 'Invoices go in ~/Documents/Finance', about: ['invoice', 'finance'], toldByUser: true } }],
      [{ name: 'remember', input: { text: 'Bank password is hunter2', about: ['bank'], toldByUser: true } }],
      [{ name: 'finish', input: { success: true, headline: 'Done.' } }]
    ])
    const t = await h.run('file these invoices in Finance and always do that', { planner })
    assert.deepEqual(h.memories.map((m) => m.text), ['Invoices go in ~/Documents/Finance'])
    assert.ok(t.summary!.evidence.some((e) => e.label === 'Remembered'))
  })
})
