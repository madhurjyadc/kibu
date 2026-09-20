import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/services/db.js'
import { defaultLimits, emptyAuthorization, type TaskState } from '../src/shared/types.js'

function task(id: string, file: string): TaskState {
  return { id, request: 'Find my private document', status: 'succeeded', petState: 'finished', outcome: '', statusLine: 'Done',
    authorization: emptyAuthorization(), limits: defaultLimits(), observations: [], plan: [],
    actions: [{ id: `${id}-action`, step: 1, tool: 'files_move', input: {}, outcome: 'success', startedAt: 1, undo: { kind: 'file.move', payload: { from: `${file}.old`, to: file } } }],
    cost: { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0 }, completionCriteria: [], createdAt: 0, updatedAt: 0 }
}

test('deletion removes saved data and undo, preserves files, and rejects late writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kibu-history-'))
  const store = new Store(dir)
  try {
    const file = join(dir, 'kept.txt')
    await writeFile(file, 'keep me')
    const t = task('finished', file)
    const log = { taskId: t.id, at: 1, level: 'info' as const, source: 'test', message: 'private task details' }
    store.saveTask(t); store.appendLog(log)
    assert.equal(store.undoableActions(t.id).length, 1)
    store.deleteTask(t.id)
    assert.equal(store.getTask(t.id), null)
    assert.deepEqual(store.getLogs(t.id), [])
    assert.deepEqual(store.undoableActions(t.id), [])
    assert.equal(await readFile(file, 'utf8'), 'keep me')
    store.saveTask(t); store.appendLog(log)
    assert.equal(store.getTask(t.id), null)
    assert.deepEqual(store.getLogs(t.id), [])
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('clear history keeps active tasks and deletion remains gone after reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kibu-history-clear-'))
  let store = new Store(dir)
  try {
    const active = { ...task('active', 'not-a-real-file'), status: 'executing' as const }
    store.saveTask(active)
    store.saveTask(task('finished', 'not-a-real-file'))
    assert.throws(() => store.deleteTask('active'), /Stop/)
    assert.deepEqual(store.clearHistory(), ['finished'])
    assert.equal(store.getTask('active')?.status, 'executing')
    store.close(); store = new Store(dir)
    assert.equal(store.getTask('finished'), null)
    assert.equal(store.listTasks().length, 1)
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})
