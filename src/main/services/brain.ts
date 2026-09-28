import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { join, isAbsolute } from 'node:path'
import { mkdirSync } from 'node:fs'
import { brainRequest } from '../../shared/brain-schema.js'
import { dayKey, timerRemaining, type BrainItem, type BrainSnapshot, type BrainTimer } from '../../shared/brain.js'
import { externalWebUrl } from '../../shared/web-url.js'

/** Main-process ownership keeps reminders alive when a model or runtime stops. */
export class BrainStore {
  private db: DatabaseSync
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true })
    this.db = new DatabaseSync(join(directory, 'brain.db'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pending_items ON items(json_extract(data, '$.dueAt'))
        WHERE json_extract(data, '$.status')='open' AND json_extract(data, '$.notifiedAt') IS NULL AND json_extract(data, '$.acknowledgedAt') IS NULL;
      CREATE TABLE IF NOT EXISTS timer (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`)
  }
  snapshot(): BrainSnapshot {
    const items = (this.db.prepare('SELECT data FROM items').all() as { data: string }[]).map(r => JSON.parse(r.data) as BrainItem)
    const timer = this.db.prepare('SELECT data FROM timer WHERE id=1').get() as { data: string } | undefined
    return { items: items.sort((a, b) => b.updatedAt - a.updatedAt), timer: timer ? JSON.parse(timer.data) as BrainTimer : null }
  }
  private save(item: BrainItem): void {
    this.db.prepare('INSERT INTO items VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(item.id, JSON.stringify(item))
  }
  private saveTimer(timer: BrainTimer | null): void {
    if (!timer) this.db.exec('DELETE FROM timer')
    else this.db.prepare('INSERT INTO timer VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(timer))
  }
  private validate(item: BrainItem, state: BrainSnapshot): void {
    if (item.projectId && !state.items.some(p => p.id === item.projectId && p.kind === 'project')) throw new Error('Choose an existing project.')
    if (item.kind === 'project' && item.projectId) throw new Error('Projects cannot be nested.')
    if (item.repeat !== 'none' && item.dueAt === null) throw new Error('A repeating reminder needs a due time.')
    for (const source of item.sources) {
      if (source.kind === 'url') externalWebUrl(source.value)
      else if (!isAbsolute(source.value)) throw new Error('Saved files need an absolute path.')
    }
  }
  request(raw: unknown, now = Date.now()): BrainSnapshot {
    const req = brainRequest.parse(raw)
    const state = this.snapshot()
    if (req.op === 'list') {
      const words = req.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
      return { ...state, items: state.items.filter(i => (!req.id || i.id === req.id) && (!req.kind || i.kind === req.kind) && (!req.projectId || i.projectId === req.projectId || i.id === req.projectId) && words.every(w => `${i.title} ${i.body} ${i.sources.map(s => s.label).join(' ')}`.toLowerCase().includes(w))) }
    }
    if (req.op === 'timer') {
      let timer = state.timer
      if (req.action === 'start') {
        if (!req.minutes) throw new Error('Choose a timer duration.')
        if (timer) throw new Error('Finish or cancel the current timer first.')
        const durationMs = Math.round(req.minutes * 60000)
        timer = { id: randomUUID(), label: req.label ?? 'Focus time', durationMs, remainingMs: durationMs, endsAt: now + durationMs, status: 'running', notifiedAt: null }
      } else if (req.action === 'cancel') timer = null
      else {
        if (!timer) throw new Error('There is no timer running.')
        if (req.action === 'pause' && timer.status === 'running') {
          const remainingMs = timerRemaining(timer, now)
          timer = remainingMs > 0 ? { ...timer, remainingMs, endsAt: null, status: 'paused' } : { ...timer, remainingMs: 0, status: 'ringing' }
        } else if (req.action === 'resume' && timer.status === 'paused') timer = { ...timer, endsAt: now + timer.remainingMs, status: 'running' }
      }
      this.saveTimer(timer)
    } else if (req.op === 'create') {
      const item: BrainItem = { ...req.item, id: randomUUID(), status: 'open', createdAt: now, updatedAt: now, notifiedAt: null, acknowledgedAt: null, checks: [] }
      this.validate(item, state)
      this.save(item)
    } else {
      const old = state.items.find(i => i.id === req.id)
      if (!old) throw new Error('This item no longer exists.')
      let item = { ...old, updatedAt: now }
      if (req.op === 'update') {
        if (old.kind === 'project' && req.changes.kind && req.changes.kind !== 'project' && state.items.some(i => i.projectId === old.id)) throw new Error('Move this project’s items before changing its type.')
        item = { ...item, ...req.changes }
        if (req.changes.dueAt !== undefined) { item.notifiedAt = null; item.acknowledgedAt = null }
      } else if (req.op === 'complete') {
        if (item.repeat !== 'none' && item.dueAt !== null && item.status === 'open') {
          const next = new Date(item.dueAt)
          // Calendar days preserve local clock time through daylight-saving changes.
          do { next.setDate(next.getDate() + (item.repeat === 'daily' ? 1 : 7)) } while (next.getTime() <= now)
          item.dueAt = next.getTime(); item.notifiedAt = null; item.acknowledgedAt = null
        } else item.status = 'done'
      } else if (req.op === 'reopen') { item.status = 'open'; item.notifiedAt = null; item.acknowledgedAt = null }
      else if (req.op === 'archive') item.status = 'archived'
      else if (req.op === 'acknowledge') item.acknowledgedAt = now
      else if (req.op === 'snooze') { item.dueAt = now + req.minutes * 60000; item.notifiedAt = null; item.acknowledgedAt = null; item.status = 'open' }
      else if (req.op === 'check') {
        if (item.kind !== 'tracker') throw new Error('Only trackers have daily check-ins.')
        const day = dayKey(now)
        item.checks = item.checks.includes(day) ? item.checks.filter(d => d !== day) : [...item.checks, day]
      }
      this.validate(item, state)
      this.save(item)
    }
    return this.snapshot()
  }
  hasDue(now = Date.now()): boolean {
    const item = this.db.prepare("SELECT 1 FROM items WHERE json_extract(data, '$.status')='open' AND json_extract(data, '$.notifiedAt') IS NULL AND json_extract(data, '$.acknowledgedAt') IS NULL AND json_extract(data, '$.dueAt') <= ? LIMIT 1").get(now)
    const timer = this.db.prepare("SELECT 1 FROM timer WHERE json_extract(data, '$.notifiedAt') IS NULL AND (json_extract(data, '$.status')='ringing' OR (json_extract(data, '$.status')='running' AND json_extract(data, '$.endsAt') <= ?))").get(now)
    return !!item || !!timer
  }
  /** One delivery per due occurrence; persisted claims prevent repeat alerts after restart. */
  tick(now = Date.now()): { state: BrainSnapshot; alerts: { id: string; title: string; timer: boolean }[] } {
    const state = this.snapshot()
    const alerts: { id: string; title: string; timer: boolean }[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of state.items) {
        if (item.status !== 'open' || item.dueAt === null || item.dueAt > now || item.notifiedAt !== null || item.acknowledgedAt !== null) continue
        item.notifiedAt = now
        this.save(item)
        alerts.push({ id: item.id, title: item.title, timer: false })
      }
      const timer = state.timer
      if (timer && ((timer.status === 'running' && timer.endsAt! <= now) || timer.status === 'ringing') && timer.notifiedAt === null) {
        timer.status = 'ringing'; timer.remainingMs = 0; timer.notifiedAt = now
        this.saveTimer(timer)
        alerts.push({ id: timer.id, title: timer.label, timer: true })
      }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    return { state, alerts }
  }
  close(): void { this.db.close() }
}
