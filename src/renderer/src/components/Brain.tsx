import { useEffect, useState } from 'react'
import { dayKey, dueItems, emptyBrain, timerRemaining, type BrainDraft, type BrainItem, type BrainKind, type BrainRequest, type BrainSnapshot, type BrainSource, type BrainTimer } from '../../../shared/brain.js'
import { Icon, type IconName } from './Icon.js'
import { DotClock } from './Dots.js'
import { Sprite } from './Sprite.js'

export function useBrain(): BrainSnapshot {
  const [state, setState] = useState(emptyBrain)
  useEffect(() => {
    let live = true
    let changed = false
    const off = window.kibu.onBrainChanged(s => { changed = true; if (live) setState(s) })
    void window.kibu.getBrain().then(s => { if (live && !changed) setState(s) }).catch(() => {})
    return () => { live = false; off() }
  }, [])
  return state
}
export function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  return now
}
const kinds: [BrainKind, string][] = [['note', 'Notes'], ['task', 'Tasks'], ['reminder', 'Reminders'], ['project', 'Projects'], ['bookmark', 'Saved'], ['session', 'Sessions'], ['tracker', 'Trackers']]
function localTime(ms: number | null | undefined): string {
  if (!ms) return ''
  const date = new Date(ms)
  return new Date(ms - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
function dateLabel(ms: number): string { return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }

const ICON: Record<BrainKind, IconName> = { note: 'rename', task: 'check', reminder: 'clock', project: 'folder', bookmark: 'pin', session: 'expand', tracker: 'spark' }

export function Brain({ state, onCompose }: { state: BrainSnapshot; onCompose: (text: string) => void }): React.JSX.Element {
  const now = useNow()
  const [tab, setTab] = useState<BrainKind | 'today' | 'archive'>('today')
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [editing, setEditing] = useState<BrainItem | BrainDraft | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const projects = state.items.filter(i => i.kind === 'project' && i.status === 'open')
  const due = dueItems(state, now)
  const endToday = new Date(now); endToday.setHours(23, 59, 59, 999)
  const isToday = (i: BrainItem): boolean => i.status === 'open' && (i.kind === 'task' || i.kind === 'tracker' || (i.dueAt !== null && i.dueAt <= endToday.getTime()))
  const count = (key: typeof tab): number => state.items.filter(i => key === 'archive' ? i.status === 'archived' : key === 'today' ? isToday(i) : i.status === 'open' && i.kind === key).length
  const visible = state.items.filter(i => {
    if (tab === 'archive' ? i.status !== 'archived' : i.status === 'archived') return false
    if (project && i.projectId !== project && i.id !== project) return false
    if (query) return `${i.title} ${i.body} ${i.sources.map(s => s.label).join(' ')}`.toLowerCase().includes(query.toLowerCase())
    if (tab === 'today') return isToday(i)
    return tab === 'archive' || i.kind === tab
  }).sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || b.updatedAt - a.updatedAt)
  async function act(request: BrainRequest): Promise<void> {
    setBusy(true); setError('')
    try { await window.kibu.brainRequest(request) } catch (e) { setError(e instanceof Error ? e.message : 'Could not save that.') } finally { setBusy(false) }
  }
  async function openSource(source: BrainSource): Promise<void> {
    try { if (source.kind === 'url') await window.kibu.openUrl(source.value); else await window.kibu.openPath(source.value) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not open source.') }
  }
  return <section className="brain" aria-label="Kibu workspace">
    <Focus timer={state.timer} now={now} busy={busy} act={act} />
    {due.length > 0 && <div className="notice brain-due"><span className="live" /><span>{due.length} reminder{due.length === 1 ? '' : 's'} waiting</span><button onClick={() => { setTab('today'); setQuery(''); setProject('') }}>Review</button></div>}
    <div className="brain-bar">
      <nav className="brain-tabs" aria-label="Workspace sections">{([['today', 'Today'], ...kinds, ['archive', 'Archive']] as [typeof tab, string][]).map(([key, name]) => { const n = count(key); return <button key={key} aria-pressed={tab === key} onClick={() => { setTab(key); setQuery(''); setEditing(null) }}>{name}{n > 0 && <span className="tab-count" aria-hidden="true">{n}</span>}</button> })}</nav>
      <button className="brain-add" onClick={() => setEditing({ kind: tab === 'today' || tab === 'archive' ? 'note' : tab, title: '', projectId: project || null })}><Icon name="plus" size={14} />New</button>
    </div>
    <div className="brain-search"><Icon name="search" size={14} /><input aria-label="Search workspace" placeholder="Find something you kept…" value={query} onChange={e => setQuery(e.target.value)} />{projects.length > 0 && <select aria-label="Filter by project" value={project} onChange={e => setProject(e.target.value)}><option value="">All projects</option>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select>}</div>
    {error && <p className="brain-error" role="alert">{error}</p>}
    {editing && <BrainEditor key={'id' in editing ? editing.id : 'new'} initial={editing} projects={projects} onCancel={() => setEditing(null)} onSave={async item => { await window.kibu.brainRequest('id' in editing ? { op: 'update', id: editing.id, changes: item } : { op: 'create', item }); setEditing(null) }} />}
    <div className="brain-items">
      {visible.map(item => {
        const overdue = item.status === 'open' && item.dueAt !== null && item.dueAt <= now
        const checkable = item.kind === 'task' || item.kind === 'reminder'
        const projectName = item.projectId ? state.items.find(p => p.id === item.projectId)?.title : undefined
        return <article key={item.id} className={`brain-card ${item.status === 'done' ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}`}>
          <div className="brain-card-top">
            {checkable
              ? <button className="brain-check" aria-label={`${item.status === 'done' ? 'Reopen' : 'Complete'} ${item.title}`} disabled={busy} onClick={() => void act({ op: item.status === 'done' ? 'reopen' : 'complete', id: item.id })}>{item.status === 'done' && <Icon name="check" size={12} />}</button>
              : <span className="brain-glyph"><Icon name={ICON[item.kind]} size={13} /></span>}
            <button className="brain-title" onClick={() => setEditing(item)}>{item.title}</button>
            <span className="brain-kind">{item.kind === 'bookmark' ? 'saved' : item.kind}</span>
            <span className="brain-actions">
              <button onClick={() => setEditing(item)}>Edit</button>
              <button disabled={busy} onClick={() => void act({ op: item.status === 'archived' ? 'reopen' : 'archive', id: item.id })}>{item.status === 'archived' ? 'Restore' : 'Archive'}</button>
            </span>
          </div>
          {item.body && <p className="brain-body">{item.body}</p>}
          {(projectName || item.dueAt !== null || item.estimateMinutes) && <div className="brain-meta">{projectName && <span>{projectName}</span>}{item.dueAt !== null && <time className={overdue ? 'warn' : ''} dateTime={new Date(item.dueAt).toISOString()}>{dateLabel(item.dueAt)}{item.repeat !== 'none' ? ` · ${item.repeat}` : ''}</time>}{item.estimateMinutes && <span>{item.estimateMinutes} min</span>}</div>}
          {item.sources.length > 0 && <div className="brain-sources">{item.sources.map((source, i) => <button key={i} className="chip" title={source.value} onClick={() => void openSource(source)}><Icon name={source.kind === 'url' ? 'arrow' : 'attach'} size={11} />{source.label || source.value}</button>)}</div>}
          {item.kind === 'tracker' && <div className="tracker-days">{Array.from({ length: 7 }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() - 6 + i); const key = dayKey(d.getTime()); return <span key={key} className={item.checks.includes(key) ? 'checked' : ''} title={key}>{d.toLocaleDateString([], { weekday: 'narrow' })}</span> })}<button className="text-button" aria-pressed={item.checks.includes(dayKey(now))} disabled={busy} onClick={() => void act({ op: 'check', id: item.id })}>{item.checks.includes(dayKey(now)) ? 'Done today' : 'Check in today'}</button></div>}
          {(item.kind === 'project' || item.kind === 'session' || overdue) && <div className="brain-more">
            {item.kind === 'project' && <><button onClick={() => { setProject(item.id); setTab('today') }}>View project</button><button onClick={() => onCompose(`Save where I am with project "${item.title}". My next step is `)}>Save a session</button></>}
            {item.kind === 'session' && <button onClick={() => onCompose(`Help me resume the saved Kibu session "${item.title}" (id ${item.id}). Show its next steps and saved sources.`)}>Resume with Kibu</button>}
            {overdue && <><button disabled={busy} onClick={() => void act({ op: 'snooze', id: item.id, minutes: 10 })}>In 10 min</button>{item.acknowledgedAt === null && <button disabled={busy} onClick={() => void act({ op: 'acknowledge', id: item.id })}>Dismiss alert</button>}</>}
          </div>}
        </article>
      })}
      {!visible.length && !editing && <div className="brain-empty"><Sprite state="idle" mood={query ? 'curious' : 'reading'} size={54} quiet /><strong>{query ? 'Nothing matched that.' : tab === 'today' ? 'Room to think.' : 'Nothing here yet.'}</strong><p>{query ? 'Try a title, a phrase, or another project.' : 'Add something, or just tell Kibu to keep it.'}</p><button className="text-button" onClick={() => onCompose(tab === 'today' ? 'Remind me to ' : tab === 'tracker' ? 'Track reading daily' : tab === 'session' ? 'Save where I am. My next step is ' : 'Note: ')}>Ask Kibu <Icon name="arrow" size={13} /></button></div>}
    </div>
    <p className="brain-footnote">Kept on this Mac · reminders catch up when Kibu runs again</p>
  </section>
}

/** The focus timer. While it runs, the pet on the desktop is a little TV showing the same clock. */
function Focus({ timer, now, busy, act }: { timer: BrainTimer | null; now: number; busy: boolean; act: (r: BrainRequest) => Promise<void> }): React.JSX.Element {
  const [minutes, setMinutes] = useState(25)
  const [label, setLabel] = useState('Focus time')
  if (!timer) {
    const valid = minutes >= 1 && minutes <= 1440 && !!label.trim()
    return <form className="focus is-idle" onSubmit={e => { e.preventDefault(); if (valid) void act({ op: 'timer', action: 'start', minutes, label }) }}>
      <span className="focus-screen"><DotClock ms={(Number.isFinite(minutes) ? minutes : 0) * 60000} tone="idle" pitch={3.2} /></span>
      <div className="focus-copy"><input aria-label="Timer label" value={label} onChange={e => setLabel(e.target.value)} maxLength={100} /><span>Kibu turns into a little TV and keeps time.</span></div>
      <label className="focus-minutes"><input type="number" aria-label="Timer minutes" min="1" max="1440" value={minutes} onChange={e => setMinutes(Number(e.target.value))} /><span>min</span></label>
      <button type="submit" className="brain-add" disabled={busy || !valid}>Start</button>
    </form>
  }
  const tone = timer.status === 'running' ? 'on' : timer.status
  return <div className={`focus is-${timer.status}`}>
    <span className="focus-screen"><DotClock ms={timerRemaining(timer, now)} tone={tone} pitch={3.2} /></span>
    <div className="focus-copy"><strong>{timer.label}</strong><span>{timer.status === 'ringing' ? 'Time’s up. Take a breath.' : timer.status === 'paused' ? 'Paused · pick up when you’re ready' : 'On Kibu’s screen until it’s done'}</span></div>
    <button disabled={busy} className="text-button" onClick={() => void act({ op: 'timer', action: timer.status === 'running' ? 'pause' : timer.status === 'paused' ? 'resume' : 'cancel' })}>{timer.status === 'running' ? 'Pause' : timer.status === 'paused' ? 'Resume' : 'Finish'}</button>
    {timer.status !== 'ringing' && <button disabled={busy} className="icon-button" aria-label="Cancel timer" title="Cancel timer" onClick={() => void act({ op: 'timer', action: 'cancel' })}><Icon name="close" size={14} /></button>}
  </div>
}

function BrainEditor({ initial, projects, onCancel, onSave }: { initial: BrainDraft; projects: BrainItem[]; onCancel: () => void; onSave: (item: BrainDraft) => Promise<void> }): React.JSX.Element {
  const [item, setItem] = useState(initial)
  const [due, setDue] = useState(localTime(initial.dueAt))
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <form className="brain-editor" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError('')
    try {
      let sources = item.sources ?? []
      if (url.trim()) { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an http or https link.'); sources = [...sources, { kind: 'url', label: parsed.hostname, value: parsed.href }] }
      const dueAt = due ? new Date(due).getTime() : null
      if (dueAt !== null && !Number.isFinite(dueAt)) throw new Error('Choose a valid date and time.')
      await onSave({ kind: item.kind, title: item.title, body: item.body ?? '', sources, projectId: item.kind === 'project' ? null : item.projectId ?? null, dueAt, repeat: item.repeat ?? 'none', estimateMinutes: item.estimateMinutes ?? null })
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.') } finally { setBusy(false) }
  }}>
    <div className="editor-row"><select aria-label="Item type" value={item.kind} onChange={e => setItem({ ...item, kind: e.target.value as BrainKind })}>{kinds.map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}</select><select aria-label="Item project" value={item.projectId ?? ''} disabled={item.kind === 'project'} onChange={e => setItem({ ...item, projectId: e.target.value || null })}><option value="">No project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></div>
    <input autoFocus required maxLength={300} aria-label="Item title" placeholder="Give it a name" value={item.title} onChange={e => setItem({ ...item, title: e.target.value })} />
    <textarea aria-label="Item details" placeholder={item.kind === 'session' ? 'Where you left off. What comes next.' : 'Notes, details, or a next step…'} rows={4} maxLength={40000} value={item.body ?? ''} onChange={e => setItem({ ...item, body: e.target.value })} />
    <div className="editor-row"><label>Remind me<input aria-label="Reminder time" type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label><label>Repeat<select aria-label="Repeat reminder" value={item.repeat ?? 'none'} onChange={e => setItem({ ...item, repeat: e.target.value as 'none' | 'daily' | 'weekly' })}><option value="none">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>{item.kind === 'task' && <label>Minutes<input type="number" aria-label="Task estimate" min={1} max={1440} value={item.estimateMinutes ?? ''} onChange={e => setItem({ ...item, estimateMinutes: e.target.value ? Number(e.target.value) : null })} /></label>}</div>
    <input type="url" aria-label="Source link" placeholder="Keep a source link (optional)" value={url} onChange={e => setUrl(e.target.value)} />
    {item.sources?.map((s, i) => <div className="editor-source" key={i}><span title={s.value}>{s.label}</span><button type="button" aria-label={`Remove source ${s.label}`} onClick={() => setItem({ ...item, sources: item.sources!.filter((_, n) => n !== i) })}><Icon name="close" size={13} /></button></div>)}
    {error && <p role="alert" className="brain-error">{error}</p>}
    <div className="editor-actions"><button type="button" className="text-button" onClick={async () => { try { const paths = await window.kibu.choosePaths(); setItem(i => ({ ...i, sources: [...(i.sources ?? []), ...paths.map(value => ({ kind: 'path' as const, label: value.split('/').pop()!, value }))] })) } catch (e) { setError(String(e)) } }}><Icon name="attach" size={14} />Add files</button><button type="button" className="text-button" disabled={busy} onClick={onCancel}>Cancel</button><button className="brain-add" disabled={busy || !item.title.trim()} type="submit">{busy ? 'Saving…' : 'Save'}</button></div>
  </form>
}
