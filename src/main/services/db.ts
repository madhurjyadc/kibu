import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { isTerminal } from '../../shared/types.js'
import type { ActionRecord, TaskState, UndoEntry } from '../../shared/types.js'
import type { LogEntry, TaskSummaryRow } from '../../shared/protocol.js'

/**
 * Local persistence. Everything Kibu knows about a task stays on this machine;
 * nothing here is synced anywhere.
 */
export class Store {
  private db: DatabaseSync
  private deletedTasks = new Set<string>()

  constructor(userDataDir: string) {
    mkdirSync(userDataDir, { recursive: true })
    this.db = new DatabaseSync(join(userDataDir, 'kibu.db'))
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA secure_delete = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        request TEXT NOT NULL,
        status TEXT NOT NULL,
        headline TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        step INTEGER NOT NULL,
        tool TEXT NOT NULL,
        input_json TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        verification_json TEXT,
        undo_json TEXT,
        reversed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS actions_task ON actions(task_id);
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT
      );
      CREATE INDEX IF NOT EXISTS logs_task ON logs(task_id);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  saveTask(task: TaskState): void {
    if (this.deletedTasks.has(task.id)) return
    this.db
      .prepare(
        `INSERT INTO tasks (id, request, status, headline, created_at, updated_at, state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           headline = excluded.headline,
           updated_at = excluded.updated_at,
           state_json = excluded.state_json`
      )
      .run(
        task.id,
        task.request,
        task.status,
        task.summary?.headline ?? null,
        task.createdAt,
        task.updatedAt,
        JSON.stringify(task)
      )

    // Actions are written individually so undo survives a crash mid-task.
    const stmt = this.db.prepare(
      `INSERT INTO actions (id, task_id, step, tool, input_json, outcome, error, started_at, finished_at, verification_json, undo_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         outcome = excluded.outcome,
         error = excluded.error,
         finished_at = excluded.finished_at,
         verification_json = excluded.verification_json,
         undo_json = excluded.undo_json`
    )
    for (const a of task.actions) {
      stmt.run(
        a.id,
        task.id,
        a.step,
        a.tool,
        JSON.stringify(a.input ?? null),
        a.outcome,
        a.error ?? null,
        a.startedAt,
        a.finishedAt ?? null,
        a.verification ? JSON.stringify(a.verification) : null,
        a.undo ? JSON.stringify(a.undo) : null
      )
    }
  }

  getTask(id: string): TaskState | null {
    const row = this.db.prepare('SELECT state_json FROM tasks WHERE id = ?').get(id) as
      | { state_json: string }
      | undefined
    return row ? (JSON.parse(row.state_json) as TaskState) : null
  }

  isDeleted(id: string): boolean { return this.deletedTasks.has(id) }

  /** Remove task data, logs, and undo records. Never operate on user files. */
  deleteTask(id: string): void {
    const task = this.getTask(id)
    if (task && !isTerminal(task.status)) throw new Error('Stop this task before deleting it.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM logs WHERE task_id = ?').run(id)
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
      this.db.exec('COMMIT')
      this.deletedTasks.add(id)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  clearHistory(): string[] {
    const rows = this.db.prepare("SELECT id FROM tasks WHERE status IN ('succeeded', 'failed', 'cancelled')").all() as { id: string }[]
    for (const row of rows) this.deleteTask(row.id)
    return rows.map((r) => r.id)
  }

  listTasks(limit = 25): TaskSummaryRow[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.request, t.status, t.headline, t.created_at,
                (SELECT COUNT(*) FROM actions a WHERE a.task_id = t.id AND a.undo_json IS NOT NULL AND a.reversed = 0) AS undoable
         FROM tasks t ORDER BY t.created_at DESC LIMIT ?`
      )
      .all(limit) as {
      id: string
      request: string
      status: string
      headline: string | null
      created_at: number
      undoable: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      request: r.request,
      status: r.status as TaskSummaryRow['status'],
      headline: r.headline ?? '',
      createdAt: r.created_at,
      undoable: r.undoable > 0
    }))
  }

  /** Reversible actions for a task, newest first — undo runs in reverse order. */
  undoableActions(taskId: string): { id: string; undo: UndoEntry }[] {
    const rows = this.db
      .prepare(
        `SELECT id, undo_json FROM actions
         WHERE task_id = ? AND undo_json IS NOT NULL AND reversed = 0 AND outcome != 'failure'
         ORDER BY started_at DESC`
      )
      .all(taskId) as { id: string; undo_json: string }[]
    return rows.map((r) => ({ id: r.id, undo: JSON.parse(r.undo_json) as UndoEntry }))
  }

  markReversed(actionId: string): void {
    this.db.prepare('UPDATE actions SET reversed = 1 WHERE id = ?').run(actionId)
  }

  appendLog(entry: LogEntry): void {
    if (this.deletedTasks.has(entry.taskId)) return
    this.db
      .prepare('INSERT INTO logs (task_id, at, level, source, message, data_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        entry.taskId,
        entry.at,
        entry.level,
        entry.source,
        entry.message,
        entry.data === undefined ? null : JSON.stringify(entry.data)
      )
  }

  getLogs(taskId: string, limit = 200): LogEntry[] {
    const rows = this.db
      .prepare('SELECT task_id, at, level, source, message, data_json FROM logs WHERE task_id = ? ORDER BY at ASC LIMIT ?')
      .all(taskId, limit) as {
      task_id: string
      at: number
      level: string
      source: string
      message: string
      data_json: string | null
    }[]
    return rows.map((r) => ({
      taskId: r.task_id,
      at: r.at,
      level: r.level as LogEntry['level'],
      source: r.source,
      message: r.message,
      data: r.data_json ? JSON.parse(r.data_json) : undefined
    }))
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  /**
   * Called at startup. A task still marked as running means we crashed or were
   * force-quit; it is recorded as interrupted rather than silently resumed,
   * because blindly repeating half-finished actions is how duplicates happen.
   */
  recoverInterruptedTasks(): string[] {
    const running = ['pending', 'observing', 'planning', 'executing', 'verifying', 'awaiting_user', 'paused']
    const placeholders = running.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT id, state_json FROM tasks WHERE status IN (${placeholders})`)
      .all(...running) as { id: string; state_json: string }[]

    for (const row of rows) {
      const task = JSON.parse(row.state_json) as TaskState
      task.status = 'failed'
      task.error = 'Kibu quit while this task was running. Nothing was resumed automatically.'
      task.statusLine = 'Interrupted'
      task.summary = {
        headline: 'Interrupted when Kibu quit',
        evidence: task.summary?.evidence ?? [],
        undoable: this.undoableActions(task.id).length > 0
      }
      this.saveTask(task)
    }
    return rows.map((r) => r.id)
  }

  close(): void {
    this.db.close()
  }
}

export type { ActionRecord }
