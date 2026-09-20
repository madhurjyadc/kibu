import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { TaskRunner, type RunnerDeps, type RunnerHooks } from '../src/runtime/loop/task-runner.js'
import type { PlannerLike, PlannerProposal } from '../src/runtime/model/planner.js'
import { ToolRegistry } from '../src/runtime/tools/registry.js'
import { fileTools } from '../src/runtime/tools/files.js'
import { userTools } from '../src/runtime/tools/user.js'
import { desktopTools } from '../src/runtime/tools/desktop.js'
import { defaultLimits, emptyAuthorization, type TaskState } from '../src/shared/types.js'
import { DEFAULT_MODEL_CONFIG } from '../src/shared/protocol.js'

/** A planner that reads from a script instead of calling a model. */
class ScriptedPlanner implements PlannerLike {
  public results: { content: string; isError: boolean }[] = []
  public notes: string[] = []
  private turn = 0

  constructor(private readonly script: { name: string; input: unknown }[][]) {}

  seed(): void {}
  addToolResults(results: { content: string; isError: boolean }[]): void {
    this.results.push(...results)
  }
  addNote(note: string): void {
    this.notes.push(note)
  }
  async propose(): Promise<PlannerProposal> {
    const calls = this.script[this.turn] ?? []
    this.turn++
    return {
      calls: calls.map((c, i) => ({ id: `call-${this.turn}-${i}`, name: c.name, input: c.input })),
      text: calls.length ? '' : 'nothing left to do',
      stopReason: calls.length ? 'tool_use' : 'end_turn',
      usd: 0.001,
      inputTokens: 100,
      outputTokens: 50
    }
  }
}

let root: string
const registry = new ToolRegistry()
registry.registerAll([...fileTools, ...userTools, ...desktopTools])

interface Harness {
  runner: TaskRunner
  updates: TaskState[]
  petStates: string[]
  desktopClaims: string[]
}

function harness(
  task: TaskState,
  script: { name: string; input: unknown }[][],
  answer?: (q: NonNullable<TaskState['question']>) => { optionId: string | null; text?: string },
  onEachUpdate?: (t: TaskState, runner: TaskRunner) => void
): Harness {
  const updates: TaskState[] = []
  const petStates: string[] = []
  const desktopClaims: string[] = []

  const hooks: RunnerHooks = {
    onUpdate: (t) => {
      updates.push(structuredClone(t))
      onEachUpdate?.(t, runner)
      // Answer questions the moment they appear, the way the UI would.
      if (t.question && answer) {
        const q = t.question
        queueMicrotask(() => runner.answer({ questionId: q.id, ...answer(q) }))
      }
    },
    onPetState: (s) => petStates.push(s),
    onLog: () => {},
    claimDesktop: async (_id, reason) => {
      desktopClaims.push(reason)
    },
    releaseDesktop: () => {}
  }

  const deps: RunnerDeps = {
    os: {
      supports: () => false,
      listApps: async () => [],
      listDisplays: async () => [{ id: 1, bounds: { x: 0, y: 0, width: 1470, height: 956 }, scaleFactor: 2, primary: true }]
    } as unknown as RunnerDeps['os'],
    // A browser that is simply never open: these tests do not touch the web.
    browser: { isOpen: () => false, close: async () => {}, page: async () => { throw new Error('no browser in this test') } } as unknown as RunnerDeps['browser'],
    registry,
    model: DEFAULT_MODEL_CONFIG,
    apiKey: null,
    jevEnabled: false,
    jevApiKey: null,
    workflowsEnabled: false,
    droppedPaths: [],
    frontWindow: null,
    previousTurn: null,
    confirmEveryAction: false,
    createPlanner: () => new ScriptedPlanner(script)
  }

  const runner = new TaskRunner(task, deps, hooks)
  return { runner, updates, petStates, desktopClaims }
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const auth = emptyAuthorization()
  auth.readRoots = [root]
  auth.writeRoots = [root]
  auth.capabilities = ['files.read', 'files.write', 'user.interact']
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    request: 'organise this folder',
    outcome: '',
    status: 'pending',
    petState: 'idle',
    authorization: auth,
    limits: defaultLimits(),
    observations: [],
    plan: [],
    actions: [],
    cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    completionCriteria: [],
    statusLine: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'kibu-runner-'))
  for (const name of ['a.pdf', 'b.pdf', 'c.png']) {
    await fs.writeFile(join(root, name), name)
  }
})
after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('the task loop end to end', () => {
  test('organises a folder through preview, moves and verified completion', async () => {
    const dest = join(root, 'PDFs')
    const task = makeTask()
    const h = harness(
      task,
      [
        [{ name: 'report_progress', input: { line: 'Looking through the folder' } }],
        [{ name: 'files_list', input: { path: root, includeHidden: false } }],
        [
          {
            name: 'show_preview',
            input: {
              title: 'Move 2 PDFs into PDFs/',
              fileOps: [
                { from: join(root, 'a.pdf'), to: join(dest, 'a.pdf'), kind: 'move' },
                { from: join(root, 'b.pdf'), to: join(dest, 'b.pdf'), kind: 'move' }
              ]
            }
          }
        ],
        [{ name: 'files_create_folder', input: { path: dest } }],
        [
          { name: 'files_move', input: { from: join(root, 'a.pdf'), to: join(dest, 'a.pdf'), onConflict: 'rename' } },
          { name: 'files_move', input: { from: join(root, 'b.pdf'), to: join(dest, 'b.pdf'), onConflict: 'rename' } }
        ],
        [
          {
            name: 'finish',
            input: {
              success: true,
              headline: 'Moved 2 PDFs into PDFs',
              evidence: [{ kind: 'path', label: 'PDFs', value: dest }]
            }
          }
        ]
      ],
      () => ({ optionId: 'approve' })
    )

    const final = await h.runner.run()

    assert.equal(final.status, 'succeeded')
    assert.equal(final.summary!.headline, 'Moved 2 PDFs into PDFs')
    // The files really moved.
    assert.equal(await fs.readFile(join(dest, 'a.pdf'), 'utf8'), 'a.pdf')
    assert.equal(await fs.readFile(join(dest, 'b.pdf'), 'utf8'), 'b.pdf')
    // The untouched file stayed put.
    assert.ok(await fs.stat(join(root, 'c.png')))
    // Every move was independently verified, not merely reported.
    const moves = final.actions.filter((a) => a.tool === 'files_move')
    assert.equal(moves.length, 2)
    assert.ok(moves.every((m) => m.verification?.verified === true))
    // Undo was recorded for the reversible operations.
    assert.equal(final.summary!.undoable, true)
    assert.equal(h.runner.undoEntries.length, 3) // folder + 2 moves
    assert.ok(h.petStates.includes('working'))
    assert.ok(h.petStates.includes('finished'))
  })

  test('a rejected preview stops the moves from happening', async () => {
    const dest = join(root, 'Rejected')
    const task = makeTask()
    const h = harness(
      task,
      [
        [{ name: 'show_preview', input: { title: 'Move c.png', fileOps: [{ from: join(root, 'c.png'), to: join(dest, 'c.png'), kind: 'move' }] } }],
        [{ name: 'finish', input: { success: false, headline: 'Cancelled at your request', evidence: [], unresolved: 'user declined' } }]
      ],
      () => ({ optionId: 'reject' })
    )

    const final = await h.runner.run()
    assert.equal(final.status, 'failed')
    // c.png must still be where it started.
    assert.equal(await fs.readFile(join(root, 'c.png'), 'utf8'), 'c.png')
    await assert.rejects(() => fs.access(dest))
  })

  test('a rejected preview is enforced in code even if the model tries anyway', async () => {
    const dest = join(root, 'Enforced')
    await fs.mkdir(dest, { recursive: true })
    await fs.writeFile(join(root, 'guard.txt'), 'guarded')
    const from = join(root, 'guard.txt')
    const to = join(dest, 'guard.txt')

    const task = makeTask()
    const h = harness(
      task,
      [
        [{ name: 'show_preview', input: { title: 'Move guard.txt', fileOps: [{ from, to, kind: 'move' }] } }],
        // The model ignores the refusal and attempts the move anyway.
        [{ name: 'files_move', input: { from, to, onConflict: 'rename' } }],
        [{ name: 'finish', input: { success: false, headline: 'Blocked', evidence: [] } }]
      ],
      () => ({ optionId: 'reject' })
    )

    await h.runner.run()

    const move = task.actions.find((a) => a.tool === 'files_move')
    assert.equal(move, undefined, 'the move must never execute')
    assert.equal(await fs.readFile(from, 'utf8'), 'guarded')
    await assert.rejects(() => fs.access(to))
  })

  test('an action outside the authorized roots pauses and asks, then proceeds once granted', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'kibu-outside-'))
    const task = makeTask()
    let asked: string | null = null

    const h = harness(
      task,
      [
        [{ name: 'files_create_folder', input: { path: join(outside, 'New') } }],
        [{ name: 'finish', input: { success: true, headline: 'Created it', evidence: [] } }]
      ],
      (q) => {
        asked = q.prompt
        assert.equal(q.reason, 'authorization')
        return { optionId: 'allow' }
      }
    )

    const final = await h.runner.run()
    assert.ok(asked, 'the runner must ask before acting outside its authorization')
    assert.match(asked!, /needs your OK/)
    assert.equal(final.status, 'succeeded')
    assert.ok(await fs.stat(join(outside, 'New')))
    await fs.rm(outside, { recursive: true, force: true })
  })

  test('a denied authorization request does not perform the action', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'kibu-denied-'))
    const task = makeTask()
    const h = harness(
      task,
      [
        [{ name: 'files_create_folder', input: { path: join(outside, 'Nope') } }],
        [{ name: 'finish', input: { success: false, headline: 'Blocked', evidence: [], unresolved: 'no permission' } }]
      ],
      () => ({ optionId: 'deny' })
    )

    await h.runner.run()
    await assert.rejects(() => fs.access(join(outside, 'Nope')))
    await fs.rm(outside, { recursive: true, force: true })
  })

  test('a protected system path is refused without ever asking the user', async () => {
    const task = makeTask()
    let questionCount = 0
    const h = harness(
      task,
      [
        [{ name: 'files_create_folder', input: { path: '/System/KibuShouldNeverDoThis' } }],
        [{ name: 'finish', input: { success: false, headline: 'Refused', evidence: [] } }]
      ],
      () => {
        questionCount++
        return { optionId: 'allow' }
      }
    )

    await h.runner.run()
    assert.equal(questionCount, 0, 'a protected path must be refused, never escalated to the user')
    await assert.rejects(() => fs.access('/System/KibuShouldNeverDoThis'))
  })

  test('malformed tool input is rejected locally and reported back to the model', async () => {
    const task = makeTask()
    const h = harness(task, [
      [{ name: 'files_move', input: { from: 123, to: null } }],
      [{ name: 'finish', input: { success: false, headline: 'Bad input', evidence: [] } }]
    ])
    await h.runner.run()
    // Nothing was executed, and the failure was fed back rather than thrown.
    assert.equal(task.actions.filter((a) => a.tool === 'files_move').length, 0)
  })

  test('an unknown tool name is handled without crashing the loop', async () => {
    const task = makeTask()
    const h = harness(task, [
      [{ name: 'files_delete_everything', input: {} }],
      [{ name: 'finish', input: { success: false, headline: 'No such tool', evidence: [] } }]
    ])
    const final = await h.runner.run()
    assert.equal(final.status, 'failed')
  })

  test('the step limit ends the task instead of running forever', async () => {
    const task = makeTask({ limits: { ...defaultLimits(), maxSteps: 3 } })
    // A script that never calls finish.
    const h = harness(task, Array(20).fill([{ name: 'report_progress', input: { line: 'still going' } }]))
    const final = await h.runner.run()
    assert.equal(final.status, 'failed')
    assert.match(final.summary!.headline, /3-step limit/)
  })

  test('the spending limit ends the task', async () => {
    const task = makeTask({ limits: { ...defaultLimits(), maxUsd: 0.0015 } })
    const h = harness(task, Array(20).fill([{ name: 'report_progress', input: { line: 'spending' } }]))
    const final = await h.runner.run()
    assert.equal(final.status, 'failed')
    assert.match(final.summary!.headline, /spending limit/)
  })

  test('cancelling mid-task stops it before the remaining steps run', async () => {
    const dest = join(root, 'Cancelled')
    await fs.mkdir(dest, { recursive: true })
    await fs.writeFile(join(root, 'one.txt'), '1')
    await fs.writeFile(join(root, 'two.txt'), '2')

    const task = makeTask()
    const script = [
      [{ name: 'files_move', input: { from: join(root, 'one.txt'), to: join(dest, 'one.txt'), onConflict: 'rename' } }],
      [{ name: 'files_move', input: { from: join(root, 'two.txt'), to: join(dest, 'two.txt'), onConflict: 'rename' } }],
      [{ name: 'finish', input: { success: true, headline: 'Moved both', evidence: [] } }]
    ]

    // Cancel the instant the first move is recorded — deterministic, no timers.
    const h = harness(task, script, undefined, (t, runner) => {
      if (t.actions.some((a) => a.tool === 'files_move' && a.outcome === 'success')) runner.cancel()
    })
    const final = await h.runner.run()

    assert.equal(final.status, 'cancelled')
    assert.ok(final.summary, 'a cancelled task still reports what it did')
    // The first move happened; the second must not have.
    assert.ok(await fs.stat(join(dest, 'one.txt')))
    await assert.rejects(() => fs.access(join(dest, 'two.txt')), 'cancellation must stop the remaining work')
    // What it did do is still undoable.
    assert.equal(final.summary!.undoable, true)
  })

  test('GUI tools claim the exclusive desktop session before acting', async () => {
    const task = makeTask()
    task.authorization.apps = ['TextEdit']
    task.authorization.capabilities.push('desktop.control')
    const h = harness(task, [
      [{ name: 'desktop_shortcut', input: { keys: 'cmd+s', appName: 'TextEdit' } }],
      [{ name: 'finish', input: { success: true, headline: 'Saved', evidence: [] } }]
    ])
    await h.runner.run()
    assert.equal(h.desktopClaims.length, 1)
    assert.match(h.desktopClaims[0]!, /TextEdit/)
  })

  test('a synthetic click outside every display is rejected by its precondition', async () => {
    const task = makeTask()
    task.authorization.apps = ['TextEdit']
    task.authorization.capabilities.push('desktop.control')
    const h = harness(task, [
      [{ name: 'desktop_click', input: { x: 99999, y: 99999, appName: 'TextEdit', reason: 'test' } }],
      [{ name: 'finish', input: { success: false, headline: 'Bad coordinates', evidence: [] } }]
    ])
    await h.runner.run()
    const click = task.actions.find((a) => a.tool === 'desktop_click')!
    assert.equal(click.outcome, 'failure')
    assert.match(click.error!, /not on any display/)
  })

  test('a stale element reference is reported as needing re-observation', async () => {
    const task = makeTask()
    task.authorization.apps = ['TextEdit']
    task.authorization.capabilities.push('desktop.control')
    const h = harness(task, [
      [{ name: 'desktop_press_element', input: { ref: 'w0:1.2', appName: 'TextEdit', action: 'AXPress' } }],
      [{ name: 'finish', input: { success: false, headline: 'Stale', evidence: [] } }]
    ])
    await h.runner.run()
    const press = task.actions.find((a) => a.tool === 'desktop_press_element')!
    assert.equal(press.outcome, 'failure')
    assert.match(press.error!, /Unknown element|re-inspect/i)
  })
})
