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

test('a chat is stored as one conversation: listed once, read back whole, deleted whole', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kibu-history-chat-'))
  const store = new Store(dir)
  try {
    const at = (t: TaskState, n: number, extra: Partial<TaskState>): TaskState => ({ ...t, createdAt: n, updatedAt: n, actions: [], ...extra })
    const first = at(task('c1', join(dir, 'x')), 1, { request: 'Organize my Downloads' })
    const second = at(task('c2', join(dir, 'x')), 2, { request: 'now the Desktop', replyTo: 'c1', conversationId: 'c1' })
    const other = at(task('solo', join(dir, 'x')), 3, { request: 'what time is it in Tokyo' })
    for (const t of [first, second, other]) store.saveTask(t)

    const rows = store.listTasks(10)
    assert.equal(rows.length, 2, 'one row per chat, not per message')
    const chat = rows.find((r) => r.turns === 2)!
    assert.equal(chat.request, 'Organize my Downloads', 'named by how it began')
    assert.equal(chat.id, 'c2', 'opens at its latest turn')

    assert.deepEqual(store.conversationOf('c2').map((t) => t.id), ['c1', 'c2'])
    assert.deepEqual(store.deleteConversation('c2').sort(), ['c1', 'c2'])
    assert.equal(store.getTask('c1'), null)
    assert.ok(store.getTask('solo'))
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('a database from before chats were stored opens with each old task as its own chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kibu-history-migrate-'))
  const { DatabaseSync } = await import('node:sqlite')
  const old = new DatabaseSync(join(dir, 'kibu.db'))
  old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, request TEXT NOT NULL, status TEXT NOT NULL, headline TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, state_json TEXT NOT NULL)`)
  const legacy = task('legacy', join(dir, 'x'))
  old.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy', legacy.request, 'succeeded', 'Found', 1, 1, JSON.stringify(legacy))
  old.close()
  const store = new Store(dir)
  try {
    const rows = store.listTasks(10)
    assert.deepEqual(rows.map((r) => [r.id, r.turns]), [['legacy', 1]])
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})
