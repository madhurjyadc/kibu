import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { Jev } from '../src/runtime/model/jev.js'
import { costOf, rateFor } from '../src/runtime/model/pricing.js'
import { Store } from '../src/main/services/db.js'
import { undoTask } from '../src/main/services/undo.js'
import { defaultLimits, emptyAuthorization, isStale, type ActionRecord, type TaskState } from '../src/shared/types.js'

function task(actions: Partial<ActionRecord>[]): TaskState {
  return {
    id: 't1',
    request: 'r',
    outcome: 'r',
    status: 'executing',
    petState: 'working',
    authorization: emptyAuthorization(),
    limits: defaultLimits(),
    observations: [],
    plan: [],
    actions: actions.map((a, i) => ({
      id: `a${i}`,
      step: i,
      tool: 'files_move',
      input: {},
      startedAt: i,
      outcome: 'success',
      ...a
    })) as ActionRecord[],
    cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    completionCriteria: [],
    statusLine: '',
    createdAt: 0,
    updatedAt: 0
  }
}

describe('progress detection (deterministic, never a Jev call)', () => {
  const jev = new Jev(null, false)

  test('an empty history continues', () => {
    assert.equal(jev.assessProgressLocally(task([])).action, 'continue')
  })

  test('hitting the consecutive-failure budget asks for help', () => {
    const v = jev.assessProgressLocally(
      task([{ outcome: 'success' }, { outcome: 'failure' }, { outcome: 'failure' }, { outcome: 'failure' }])
    )
    assert.equal(v.action, 'ask')
    assert.equal(v.deterministic, true)
  })

  test('a success resets the failure streak', () => {
    const v = jev.assessProgressLocally(
      task([{ outcome: 'failure' }, { outcome: 'failure' }, { outcome: 'success' }])
    )
    assert.equal(v.action, 'continue')
  })

  test('the same tool failing identically twice triggers a replan, not a retry', () => {
    const v = jev.assessProgressLocally(
      task([
        { outcome: 'failure', tool: 'files_move', error: 'permission denied' },
        { outcome: 'failure', tool: 'files_move', error: 'permission denied' }
      ])
    )
    assert.equal(v.action, 'replan')
  })

  test('a staleness error asks for a fresh observation instead of a replan', () => {
    const v = jev.assessProgressLocally(
      task([
        { outcome: 'failure', tool: 'desktop_press_element', error: 'element changed; re-inspect first' },
        { outcome: 'failure', tool: 'desktop_press_element', error: 'element changed; re-inspect first' }
      ])
    )
    assert.equal(v.action, 'reobserve')
  })

  test('an identical call repeating six times counts as no progress', () => {
    const same = { outcome: 'success' as const, tool: 'files_list', input: { path: '/x' } }
    assert.equal(jev.assessProgressLocally(task(Array(6).fill(same))).action, 'replan')
  })

  test('varied successful calls are progress', () => {
    const v = jev.assessProgressLocally(
      task([
        { tool: 'files_list', input: { path: '/a' } },
        { tool: 'files_move', input: { from: '/a/1' } },
        { tool: 'files_move', input: { from: '/a/2' } }
      ])
    )
    assert.equal(v.action, 'continue')
  })
})

describe('routing without a model', () => {
  const jev = new Jev(null, false)

  test('dropped files route to the file tools with high confidence', async () => {
    const d = await jev.routeRequest('sort these out', true)
    assert.equal(d.route, 'files')
  })

  test('a web request routes to the browser', async () => {
    const d = await jev.routeRequest('open this website and fill in the form', false)
    assert.equal(d.route, 'browser')
  })

  test('a vague two-word request is flagged for clarification', async () => {
    const d = await jev.routeRequest('do it', false)
    assert.equal(d.needsClarification, true)
  })

  test('metrics record every decision, so Jev\'s value can be measured', async () => {
    const fresh = new Jev(null, false)
    await fresh.routeRequest('organise my downloads folder', false)
    assert.equal(fresh.metrics.calls.length, 1)
    assert.equal(fresh.metrics.calls[0]!.usedModel, false)
  })
})

describe('cost limits', () => {
  test('known model rates are applied', () => {
    assert.equal(rateFor('claude-opus-5').inputPerMTok, 5)
    assert.equal(rateFor('claude-haiku-4-5').outputPerMTok, 5)
  })
  test('an unknown model is costed pessimistically so it cannot slip past a limit', () => {
    const known = costOf('claude-opus-5', 1_000_000, 0)
    const unknown = costOf('some-future-model', 1_000_000, 0)
    assert.ok(unknown > known)
  })
  test('cost maths is per million tokens', () => {
    assert.equal(costOf('claude-opus-5', 1_000_000, 1_000_000), 30)
  })
})

describe('observation staleness', () => {
  test('an observation past its window is stale', () => {
    const o = { id: 'o', kind: 'window' as const, summary: '', data: null, observedAt: 0, staleAfterMs: 1000 }
    assert.equal(isStale(o, 2000), true)
    assert.equal(isStale(o, 500), false)
  })
})

describe('undo', () => {
  let dir: string
  let store: Store

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'kibu-undo-'))
    store = new Store(join(dir, 'data'))
  })
  after(async () => {
    store.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  function saveWithUndo(id: string, kind: 'file.move' | 'folder.create', from: string, to: string): void {
    const t = task([])
    t.id = id
    t.actions = [
      {
        id: `${id}-a`,
        step: 1,
        tool: 'files_move',
        input: {},
        startedAt: 1,
        finishedAt: 2,
        outcome: 'success',
        undo: { kind, payload: { from, to } }
      }
    ]
    store.saveTask(t)
  }

  test('a move is reversed and the file returns to its original path', async () => {
    const from = join(dir, 'a.txt')
    const to = join(dir, 'moved', 'a.txt')
    await fs.mkdir(join(dir, 'moved'), { recursive: true })
    await fs.writeFile(to, 'content')
    saveWithUndo('undo1', 'file.move', from, to)

    const report = await undoTask(store, 'undo1')
    assert.equal(report.reversed, 1)
    assert.equal(await fs.readFile(from, 'utf8'), 'content')
  })

  test('undo is not applied twice', async () => {
    const second = await undoTask(store, 'undo1')
    assert.equal(second.reversed, 0)
  })

  test('undo refuses when something else now occupies the original path', async () => {
    const from = join(dir, 'busy.txt')
    const to = join(dir, 'moved', 'busy.txt')
    await fs.writeFile(from, 'squatter')
    await fs.writeFile(to, 'ours')
    saveWithUndo('undo2', 'file.move', from, to)

    const report = await undoTask(store, 'undo2')
    assert.equal(report.reversed, 0)
    assert.match(report.skipped[0]!.reason, /occupies/)
    // Neither file may be touched.
    assert.equal(await fs.readFile(from, 'utf8'), 'squatter')
    assert.equal(await fs.readFile(to, 'utf8'), 'ours')
  })

  test('undo skips a file the user has since moved away', async () => {
    saveWithUndo('undo3', 'file.move', join(dir, 'x'), join(dir, 'vanished'))
    const report = await undoTask(store, 'undo3')
    assert.equal(report.reversed, 0)
    assert.match(report.skipped[0]!.reason, /no longer where/)
  })

  test('undo never deletes a created folder that now holds files', async () => {
    const folder = join(dir, 'created')
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(join(folder, 'users-file.txt'), 'keep me')
    saveWithUndo('undo4', 'folder.create', folder, folder)

    const report = await undoTask(store, 'undo4')
    assert.equal(report.reversed, 0)
    assert.match(report.skipped[0]!.reason, /not empty/)
    assert.equal(await fs.readFile(join(folder, 'users-file.txt'), 'utf8'), 'keep me')
  })

  test('an empty created folder is removed', async () => {
    const folder = join(dir, 'empty-created')
    await fs.mkdir(folder, { recursive: true })
    saveWithUndo('undo5', 'folder.create', folder, folder)
    const report = await undoTask(store, 'undo5')
    assert.equal(report.reversed, 1)
    await assert.rejects(() => fs.access(folder))
  })
})

describe('crash recovery', () => {
  let dir: string
  let store: Store
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'kibu-recover-'))
    store = new Store(join(dir, 'data'))
  })
  after(async () => {
    store.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('a task left running is marked interrupted rather than resumed', () => {
    const t = task([])
    t.id = 'running-task'
    t.status = 'executing'
    store.saveTask(t)

    const recovered = store.recoverInterruptedTasks()
    assert.deepEqual(recovered, ['running-task'])

    const after = store.getTask('running-task')!
    assert.equal(after.status, 'failed')
    assert.match(after.error!, /quit while this task was running/)
  })

  test('a finished task is left alone', () => {
    const t = task([])
    t.id = 'done-task'
    t.status = 'succeeded'
    store.saveTask(t)
    store.recoverInterruptedTasks()
    assert.equal(store.getTask('done-task')!.status, 'succeeded')
  })
})
