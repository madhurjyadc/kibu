import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrainStore } from '../src/main/services/brain.js'
import { dayKey, dueItems, timerRemaining } from '../src/shared/brain.js'
import { TaskRunner, type RunnerDeps } from '../src/runtime/loop/task-runner.js'
import { ToolRegistry } from '../src/runtime/tools/registry.js'
import { brainTools } from '../src/runtime/tools/brain.js'
import { userTools } from '../src/runtime/tools/user.js'
import { defaultLimits, emptyAuthorization, type TaskState } from '../src/shared/types.js'
import { DEFAULT_MODEL_CONFIG } from '../src/shared/protocol.js'
import { isBrainRequest } from '../src/runtime/workflows/brain.js'

async function withBrain(run: (brain: BrainStore, dir: string) => Promise<void> | void) {
  const dir = await mkdtemp(join(tmpdir(), 'kibu-brain-'))
  const brain = new BrainStore(dir)
  try { await run(brain, dir) } finally { brain.close(); await rm(dir, { recursive: true, force: true }) }
}

test('notes, sources and projects persist independently of chat history', () => withBrain((brain, dir) => {
  const project = brain.request({ op: 'create', item: { kind: 'project', title: 'Acme' } }).items[0]!
  const note = brain.request({ op: 'create', item: { kind: 'note', title: 'Client brief', body: 'Use the monochrome logo', projectId: project.id, sources: [{ kind: 'url', label: 'Brief', value: 'https://example.com/brief' }] } }).items.find(i => i.kind === 'note')!
  const reopened = new BrainStore(dir)
  try {
    assert.throws(() => brain.request({ op: 'update', id: project.id, changes: { kind: 'note' } }), /Move this project/)
    assert.equal(reopened.request({ op: 'list', query: 'monochrome', projectId: project.id }).items[0]?.id, note.id)
    assert.equal(reopened.snapshot().items.find(i => i.id === note.id)?.sources[0]?.value, 'https://example.com/brief')
    brain.request({ op: 'archive', id: project.id })
    assert.doesNotThrow(() => brain.request({ op: 'update', id: note.id, changes: { title: 'Updated brief' } }))
    assert.equal(brain.request({ op: 'list', id: note.id }).items[0]?.body, 'Use the monochrome logo')
    assert.equal(brain.request({ op: 'list', id: note.id }).items[0]?.sources.length, 1)
    brain.request({ op: 'archive', id: note.id }); brain.request({ op: 'reopen', id: note.id })
    assert.equal(brain.request({ op: 'list', id: note.id }).items[0]?.status, 'open')
  } finally { reopened.close() }
}))

test('overdue reminders catch up after reopening and are delivered once per occurrence', () => withBrain((brain, dir) => {
  const item = brain.request({ op: 'create', item: { kind: 'reminder', title: 'Call mom', dueAt: 2000 } }, 1000).items[0]!
  assert.equal(brain.hasDue(1999), false)
  assert.equal(brain.hasDue(2000), true)
  assert.equal(brain.tick(1999).alerts.length, 0)
  const reopened = new BrainStore(dir)
  try {
    assert.equal(reopened.tick(3000).alerts[0]?.title, 'Call mom')
    assert.equal(reopened.tick(4000).alerts.length, 0)
    assert.equal(brain.tick(5000).alerts.length, 0)
    assert.equal(brain.hasDue(5000), false)
    assert.equal(dueItems(brain.snapshot(), 5000).length, 1, 'Reminder stays visible until handled')
    brain.request({ op: 'snooze', id: item.id, minutes: 10 }, 5000)
    assert.equal(brain.tick(604999).alerts.length, 0)
    assert.equal(brain.tick(605000).alerts.length, 1)
    brain.request({ op: 'acknowledge', id: item.id }, 605001)
    assert.equal(dueItems(brain.snapshot(), 605002).length, 0)
    assert.equal(brain.snapshot().items[0]?.status, 'open', 'Dismiss does not mark the task done')
  } finally { reopened.close() }
}))

test('daily completion skips missed occurrences and preserves the local reminder time', () => withBrain(brain => {
  const due = new Date(2026, 8, 25, 9).getTime(), now = new Date(2026, 8, 28, 10).getTime()
  const item = brain.request({ op: 'create', item: { kind: 'reminder', title: 'Stretch', dueAt: due, repeat: 'daily' } }, due - 1).items[0]!
  brain.tick(now)
  const next = brain.request({ op: 'complete', id: item.id }, now).items[0]!
  assert.equal(next.status, 'open')
  assert.equal(new Date(next.dueAt!).getHours(), 9)
  assert.equal(new Date(next.dueAt!).getDate(), 29)
  assert.equal(next.notifiedAt, null)
  assert.equal(brain.tick(now + 1).alerts.length, 0)
}))

test('timer uses a deadline across sleep/restart, pauses precisely and refuses replacement', () => withBrain((brain, dir) => {
  brain.request({ op: 'timer', action: 'start', minutes: 25 }, 1000)
  assert.throws(() => brain.request({ op: 'timer', action: 'start', minutes: 5 }, 2000), /current timer/)
  const paused = brain.request({ op: 'timer', action: 'pause' }, 61000).timer!
  assert.equal(timerRemaining(paused, 99999999), 24 * 60000)
  assert.equal(brain.tick(99999999).alerts.length, 0)
  brain.request({ op: 'timer', action: 'resume' }, 100000)
  const reopened = new BrainStore(dir)
  try {
    const tick = reopened.tick(100000 + 24 * 60000)
    assert.equal(tick.state.timer?.status, 'ringing')
    assert.equal(tick.alerts.length, 1)
    assert.equal(reopened.tick(999999999).alerts.length, 0)
    assert.equal(reopened.request({ op: 'timer', action: 'cancel' }).timer, null)
  } finally { reopened.close() }
}))

test('tracker checks toggle only today and retain past days', () => withBrain(brain => {
  const yesterday = new Date(2026, 8, 27, 15).getTime(), today = new Date(2026, 8, 28, 15).getTime()
  const id = brain.request({ op: 'create', item: { kind: 'tracker', title: 'Read' } }, yesterday).items[0]!.id
  brain.request({ op: 'check', id }, yesterday)
  brain.request({ op: 'check', id }, today)
  assert.deepEqual(brain.request({ op: 'check', id }, today).items[0]?.checks, [dayKey(yesterday)])
}))

test('validates dates, sources, project links and mutation fields before saving', () => withBrain(brain => {
  for (const item of [
    { kind: 'note', title: '' },
    { kind: 'note', title: 'Secret', projectId: 'missing' },
    { kind: 'reminder', title: 'Repeat', repeat: 'daily' },
    { kind: 'note', title: 'Bad link', sources: [{ kind: 'url', label: 'bad', value: 'javascript:alert(1)' }] },
    { kind: 'note', title: 'Bad date', dueAt: Infinity }
  ]) assert.throws(() => brain.request({ op: 'create', item }))
  assert.equal(brain.snapshot().items.length, 0)
}))

function makeRunner(brain: BrainStore, request: string, answers: string[] = []): TaskRunner {
  const registry = new ToolRegistry(); registry.registerAll([...brainTools, ...userTools])
  const task: TaskState = { id: 'test', request, outcome: '', status: 'pending', petState: 'idle', authorization: emptyAuthorization(), limits: defaultLimits(), observations: [], plan: [], actions: [], cost: { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0 }, completionCriteria: [], statusLine: '', createdAt: Date.now(), updatedAt: Date.now() }
  const deps: RunnerDeps = { registry, brain: async req => brain.request(req), os: { supports: () => false } as unknown as RunnerDeps['os'], browser: { isOpen: () => false } as RunnerDeps['browser'], model: DEFAULT_MODEL_CONFIG, apiKey: null, jevApiKey: null, jevEnabled: false, workflowsEnabled: true, droppedPaths: [], frontWindow: null, previousTurn: null, confirmEveryAction: false }
  const runner = new TaskRunner(task, deps, { onUpdate(t) { if (t.question) { const questionId = t.question.id; queueMicrotask(() => runner.answer({ questionId, optionId: answers.shift() ?? null })) } }, onPetState() {}, onLog() {}, async claimDesktop() {}, releaseDesktop() {} })
  return runner
}

test('real runner saves a note, starts a timer and creates a reminder without a planner', () => withBrain(async brain => {
  for (const request of ['Note: Client wants the monochrome logo', 'start a 25 minute timer', 'remind me to call mom in 2 hours', 'track reading daily', 'create a project Acme']) {
    const result = await makeRunner(brain, request).run()
    assert.equal(result.status, 'succeeded', JSON.stringify(result.summary))
    assert.equal(result.cost.calls, 0)
    assert.ok(result.actions.some(a => a.tool === 'kibu_workspace' && a.verification?.verified))
  }
  assert.equal(brain.snapshot().items.length, 4)
  assert.equal(brain.snapshot().timer?.durationMs, 1500000)
}))

test('time ambiguity asks before saving, and explicitly named Apple apps remain external', () => withBrain(async brain => {
  const result = await makeRunner(brain, 'remind me to call mom tomorrow at 7', ['1']).run()
  assert.equal(result.status, 'succeeded')
  assert.match(brain.snapshot().items[0]!.title, /Call mom/i)
  assert.equal(isBrainRequest('save this to the Notes app'), false)
  assert.equal(isBrainRequest('remind me in Apple Reminders'), false)
}))

test('sessions and explicit task estimates work through the real runner without a model', () => withBrain(async brain => {
  const saved = await makeRunner(brain, 'save where I am with Acme. Next: revise the mobile header.').run()
  assert.equal(saved.status, 'succeeded', JSON.stringify(saved.summary))
  const session = brain.snapshot().items.find(i => i.kind === 'session')!
  assert.ok(session.projectId)
  const resumed = await makeRunner(brain, 'resume project Acme').run()
  assert.match(resumed.summary!.headline, /mobile header/)
  const task = await makeRunner(brain, 'add a task Review the logo takes 20 minutes').run()
  assert.equal(task.status, 'succeeded')
  assert.equal(brain.snapshot().items.find(i => i.kind === 'task')?.estimateMinutes, 20)
}))
