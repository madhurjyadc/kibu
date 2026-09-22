import { useCallback, useEffect, useRef, useState } from 'react'
import type { BenchRow, FrontWindow, LogEntry, PanelState, PetState, TaskState, TaskSummaryRow, UserQuestion } from '../../shared/protocol.js'
import { COMMANDS, Prompt } from './components/Prompt.js'
import { Reply } from './components/Reply.js'
import { Steps } from './components/Steps.js'
import { Past } from './components/Past.js'
import { Tune } from './components/Tune.js'
import { Bench } from './components/Bench.js'
import { MOOD_FOR, Sprite, type Mood } from './components/Sprite.js'
import { Icon, type IconName } from './components/Icon.js'
import { Markdown, plainText } from './components/Markdown.js'

type View = 'home' | 'steps' | 'past' | 'keys' | 'tune' | 'help' | 'bench'
/** Matches the host's follow-up window: older turns are a different conversation. */
const THREAD_WINDOW_MS = 10 * 60 * 1000
const RUNNING = ['pending', 'observing', 'planning', 'executing', 'verifying', 'awaiting_user', 'paused']
const IDEAS: { title: string; prompt: string; icon: IconName; hint: string }[] = [
  { title: 'Find', prompt: 'Find ', icon: 'search', hint: 'a file, by name or what’s in it' },
  { title: 'Organize', prompt: 'Organize my Downloads folder', icon: 'folder', hint: 'a messy folder' },
  { title: 'Rename', prompt: 'Rename these files consistently', icon: 'rename', hint: 'files to one pattern' }
]
/** What a press may land on without moving the window. */
const NO_DRAG = 'button, a, input, textarea, select, label, summary, kbd, [role="button"]:not(.bar-face), .kibu-says, .asked, .said, pre, .ops, .peek, .palette, .chips, .proof, .steps, .pane, .help'

/** How the creature reacts to a half-typed request. */
function moodForDraft(text: string, fallback: Mood): Mood {
  const t = text.trim().toLowerCase()
  if (!t) return fallback
  if (t.startsWith('/')) return 'wink'
  if (/^(find|where|search|look for|locate)\b/.test(t)) return 'curious'
  if (/\b(please|thanks|thank you|love)\b/.test(t)) return 'happy'
  return 'listening'
}

const TITLES: Record<View, string> = { home: 'Kibu', past: 'History', steps: 'Steps', tune: 'Settings', keys: 'Connections', help: 'Shortcuts', bench: 'Diagnostics' }

export function Panel(): React.JSX.Element {
  const [view, setView] = useState<View>('home')
  const [task, setTask] = useState<TaskState | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [dropped, setDropped] = useState<string[]>([])
  const [history, setHistory] = useState<TaskSummaryRow[]>([])
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [petState, setPetState] = useState<PetState>('idle')
  const [front, setFront] = useState<FrontWindow | null>(null)
  const [desktopActive, setDesktopActive] = useState(false)
  const [aside, setAside] = useState<string | null>(null)
  const [blind, setBlind] = useState(false)
  const [bench, setBench] = useState<BenchRow[]>([])
  const [benching, setBenching] = useState(false)
  const [draft, setDraft] = useState('')
  /** Earlier turns of this conversation, oldest first. */
  const [thread, setThread] = useState<TaskState[]>([])
  const taskRef = useRef<TaskState | null>(null)
  const [seed, setSeed] = useState<{ text: string; id: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /** The panel itself is being moved. */
  const [moving, setMoving] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [panel, setPanel] = useState<PanelState>({ docked: false, pinned: false })
  const sending = useRef(false)
  const workspace = useRef<HTMLElement>(null)
  const running = !!task && RUNNING.includes(task.status)
  const refreshHistory = useCallback(() => window.kibu.listHistory(25).then(setHistory), [])
  const refreshSetup = useCallback(async () => {
    const [ready, permissions] = await Promise.all([window.kibu.canWork(), window.kibu.getPermissions()])
    setHasKey(ready)
    setBlind(permissions.some((p) => p.permission === 'accessibility' && !p.granted))
  }, [])
  const reportError = useCallback((error: unknown) => setAside(error instanceof Error ? error.message : 'Something went wrong. Please try again.'), [])

  useEffect(() => {
    const offDeleted = window.kibu.onHistoryDeleted((ids) => {
      setHistory((rows) => rows.filter((r) => !ids.includes(r.id)))
      setTask((current) => current && ids.includes(current.id) ? null : current)
      setLogs((entries) => entries.filter((l) => !ids.includes(l.taskId)))
    })
    const offTask = window.kibu.onTaskUpdate((t) => {
      // A new request after a finished one continues the conversation: the
      // finished turn moves up into the thread instead of vanishing.
      const prev = taskRef.current
      if (prev && prev.id !== t.id && !RUNNING.includes(prev.status)) {
        setThread((turns) => [...turns, prev].filter((x) => t.createdAt - x.updatedAt < THREAD_WINDOW_MS).slice(-6))
      }
      taskRef.current = t
      setTask(t)
      if (!RUNNING.includes(t.status)) void refreshHistory().catch(reportError)
    })
    const offLog = window.kibu.onLog((entry) => setLogs((prev) => [...prev.slice(-199), entry]))
    const offDropped = window.kibu.onDroppedPaths((paths) => { setDropped(paths); setView('home') })
    const offPet = window.kibu.onPetState(setPetState)
    const offSeed = window.kibu.onSeed((text) => { setView('home'); setSeed({ text, id: Date.now() }) })
    const offPanel = window.kibu.onPanelState(setPanel)
    void window.kibu.getPanelState().then(setPanel).catch(() => {})
    const offDesktop = window.kibu.onDesktopSession(setDesktopActive)
    const onFocus = (): void => {
      void refreshSetup().catch(reportError)
      void window.kibu.getFrontWindow().then(setFront).catch(reportError)
    }
    const offFocus = window.kibu.onFocusInput(() => {
      onFocus()
      document.querySelector<HTMLTextAreaElement>('#composer')?.focus()
    })
    onFocus()
    void refreshHistory().catch(reportError)
    window.addEventListener('focus', onFocus)
    return () => { offSeed(); offDeleted(); offTask(); offLog(); offDropped(); offPet(); offPanel(); offDesktop(); offFocus(); window.removeEventListener('focus', onFocus) }
  }, [refreshHistory, refreshSetup, reportError])

  // The panel is as tall as what it has to say: a one-line answer does not
  // need a 620px window, and a long preview should not have to scroll early.
  useEffect(() => {
    const el = workspace.current
    // Minimized, the window is the island: its narrow layout says nothing
    // about how tall the panel should be.
    if (!el || panel.docked) return
    const measure = (): void => {
      const style = getComputedStyle(el)
      const content = [...el.children].reduce((h, c) => h + (c as HTMLElement).offsetHeight, 0) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      // The fixed parts, measured directly: mid-animation the window height
      // is not the panel's height, so it cannot be used to work them out.
      const root = el.parentElement!
      const chrome = [...root.children].filter((c) => c !== el && c.matches('.bar, .statusbar, .return-task')).reduce((h, c) => h + (c as HTMLElement).offsetHeight, 0) + 2
      void window.kibu.resizePanel(Math.ceil((content + chrome) / 20) * 20)
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const c of el.children) observer.observe(c)
    return () => observer.disconnect()
  }, [view, task?.id, task?.status, task?.question?.id, thread.length, panel.docked, history.length])
  useEffect(() => { setConfirmClear(false); setConfirmDelete(false); workspace.current?.scrollTo({ top: 0 }) }, [view, task?.id, task?.question?.id])

  const answer = useCallback(async (question: UserQuestion, optionId: string | null, text?: string) => {
    if (!task) return
    await window.kibu.answerQuestion({ taskId: task.id, questionId: question.id, optionId, text })
  }, [task])

  const send = useCallback(async (text: string, withFront: boolean) => {
    if (sending.current) return
    sending.current = true
    try {
      setAside(null)
      if (task?.question?.allowFreeText) {
        await answer(task.question, null, text)
        setView('home')
        return
      }
      if (running) throw new Error('Finish or stop the current task first.')
      await window.kibu.startTask({ request: text, droppedPaths: dropped, includeFrontWindow: withFront })
      setDropped([])
      setLogs([])
      setView('home')
    } finally { sending.current = false }
  }, [dropped, task, running, answer])

  const command = useCallback(async (name: string) => {
    setAside(null)
    try {
      switch (name) {
        case 'undo': {
          const rows = await window.kibu.listHistory(25)
          const target = task?.summary?.undoable ? task.id : rows.find((r) => r.undoable)?.id
          if (!target) { setAside('No file changes to undo yet.'); return }
          const report = await window.kibu.undoTask(target)
          setAside(`Restored ${report.reversed} item${report.reversed === 1 ? '' : 's'}.${report.skipped.length ? ` ${report.skipped.length} skipped: ${report.skipped[0]?.reason}` : ''}`)
          await refreshHistory()
          return
        }
        case 'stop':
          if (task && running) await window.kibu.cancelTask(task.id)
          return
        case 'bench':
          setBench([]); setBenching(true); setView('bench')
          try { setBench(await window.kibu.runBench()) } finally { setBenching(false) }
          return
        case 'past': await refreshHistory(); setView('past'); return
        case 'center': await window.kibu.centerPanel(); return
        case 'steps': case 'keys': case 'tune': setView(name); return
        default: setView('help')
      }
    } catch (error) { reportError(error) }
  }, [task, running, refreshHistory, reportError])

  function compose(text: string): void { setView('home'); setSeed({ text, id: Date.now() }) }
  async function openTask(id: string): Promise<void> {
    if (running && id !== task?.id) { setAside('Finish or stop your current task before opening another.'); return }
    try { const t = await window.kibu.getTask(id); if (t) { taskRef.current = t; setThread([]); setTask(t); setView('home') } } catch (error) { reportError(error) }
  }
  async function deleteTask(id: string): Promise<void> {
    await window.kibu.deleteTask(id)
    setHistory((rows) => rows.filter((r) => r.id !== id))
    setThread((turns) => turns.filter((t) => t.id !== id))
    if (task?.id === id) { setTask(null); taskRef.current = null; setLogs([]) }
  }
  // People repeat themselves: the last few things that worked, one tap away.
  const again = [...new Map(history.filter((r) => r.status === 'succeeded').map((r) => [r.request.trim().toLowerCase(), r])).values()].slice(0, 3)
  const homeMood = moodForDraft(draft, MOOD_FOR[petState])
  const placeholder = task?.question ? (task.question.allowFreeText ? 'Your answer…' : 'Choose an option') : running ? 'Working…' : dropped.length ? 'What should I do with these?' : 'Ask Kibu…'

  /**
   * Spotlight-style moving: press on any empty part of the panel and drag.
   * Main follows the real cursor, so this only reports start, move and end.
   * Anything you click, type into, select or scroll is left alone.
   */
  const grab = useRef(false)
  const pressed = useRef<{ x: number; y: number; onFace: boolean } | null>(null)
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0 || panel.docked) return
    const target = e.target as HTMLElement
    if (target.closest(NO_DRAG)) return
    // A press on a scrollbar scrolls; it does not move the window.
    if (target.scrollHeight > target.clientHeight && e.nativeEvent.offsetX >= target.clientWidth) return
    grab.current = true
    pressed.current = { x: e.screenX, y: e.screenY, onFace: !!target.closest('.bar-face') }
    e.currentTarget.setPointerCapture(e.pointerId)
    setMoving(true)
    void window.kibu.dragPanel('start')
  }
  function onPointerMove(): void {
    if (grab.current) void window.kibu.dragPanel('move')
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    if (!grab.current) return
    grab.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    setMoving(false)
    void window.kibu.dragPanel('end')
    // A press on the face that never moved is a click: go home.
    const p = pressed.current
    if (p?.onFace && Math.hypot(e.screenX - p.x, e.screenY - p.y) < 4) setView('home')
  }

  /** One line for the island: what is happening, or how it ended. */
  const islandLine = running
    ? (task?.status === 'awaiting_user' ? 'Needs your answer' : task?.statusLine || 'Working')
    : task?.summary ? plainText(task.summary.headline) : 'Kibu'

  /** A plain answer: nothing was done, so there is no outcome to badge. */
  const isChat = !!task && task.status === 'succeeded' && task.actions.length === 0 && !task.summary?.evidence.length
  const barMood: Mood = task && view === 'home' && !draft ? MOOD_FOR[task.petState] : homeMood
  const statusText = running ? (task?.status === 'awaiting_user' ? 'needs you' : task?.status === 'paused' ? 'paused' : 'working') : desktopActive ? 'driving' : 'ready'

  return (
    <div className={`kibu ${dragging ? 'is-dropping' : ''} ${panel.docked ? 'is-docked' : ''} ${moving ? 'is-moving' : ''} ${view === 'home' && !task ? 'is-home' : ''}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest(NO_DRAG)) void window.kibu.centerPanel() }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && e.target instanceof HTMLElement && !['TEXTAREA', 'INPUT'].includes(e.target.tagName)) {
          if (view !== 'home') setView('home'); else void window.kibu.closePanel()
        }
      }}
      onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDragging(true) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
      onDrop={(e) => {
        e.preventDefault(); setDragging(false)
        const paths = Array.from(e.dataTransfer.files).map((f) => window.kibu.getPathForFile(f)).filter(Boolean)
        if (paths.length) { setDropped((prev) => [...new Set([...prev, ...paths])].slice(0, 200)); setView('home') }
      }}>
      <div className="bar">
        <div className="bar-face" role="button" tabIndex={0} aria-label="Kibu home" title="Home · drag to move · double-click to centre"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView('home') } }}><Sprite state={petState} mood={barMood} size={46} /></div>
        <div className="bar-input">
          <Prompt state={petState} placeholder={placeholder} busy={running} canAnswer={!!task?.question?.allowFreeText} seed={seed} dropped={dropped} front={front}
            onAttach={async () => { try { const paths = await window.kibu.choosePaths(); setDropped((prev) => [...new Set([...prev, ...paths])].slice(0, 200)) } catch (e) { reportError(e) } }}
            onClearDropped={() => setDropped([])} onSend={send} onCommand={command}
            onNumber={(n) => { const q = task?.question; if (!q || view !== 'home') return false; const option = (q.options ?? [{ id: 'ok', label: 'Go ahead' }])[n - 1]; if (!option) return false; void answer(q, option.id).catch(reportError); return true }}
            onEscape={() => view === 'home' ? void window.kibu.closePanel() : setView('home')} onDraft={setDraft} />
        </div>
      </div>
      <main className={`workspace ${view === 'home' && !task ? 'home-workspace' : ''}`} ref={workspace}>
        {desktopActive && <div className="driving-line"><span className="live" />Controlling your screen<button onClick={() => void window.kibu.stopDesktopSession()}>Stop</button></div>}
        {aside && <div className="notice" role="status"><span>{aside}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setAside(null)}><Icon name="close" size={15} /></button></div>}
        {view === 'home' && !task && <section className="idle-space">
          <ul className="rows" aria-label="Actions">{IDEAS.map((idea, i) => <li key={idea.title}><button className="row-button" aria-label={idea.title} style={{ animationDelay: `${i * 40}ms` }} onClick={() => compose(idea.prompt)}><span className="row-icon"><Icon name={idea.icon} size={15} /></span><span className="row-title">{idea.title}</span><span className="row-hint" data-hint={idea.hint} aria-hidden="true" /></button></li>)}</ul>
          {again.length > 0 && <><p className="rows-label">Recent</p><ul className="rows" aria-label="Do again">{again.map((r) => <li key={r.id}><button className="row-button" title={r.request} onClick={() => compose(r.request)}><span className="row-icon"><Icon name="clock" size={15} /></span><span className="row-title again-text">{r.request}</span></button></li>)}</ul></>}
        </section>}
        {view === 'home' && task && <section className="task-page">
          <div className={`task-toolbar ${isChat ? 'is-chat' : ''}`}><span className={`task-status status-pill is-${task.status} ${isChat ? 'is-hidden' : ''}`}><i />{task.status === 'awaiting_user' ? 'Your input' : task.status === 'succeeded' ? 'Done' : task.status === 'failed' ? 'Needs attention' : task.status === 'cancelled' ? 'Stopped' : task.status === 'paused' ? 'Paused' : 'Working'}</span>
            {!running && (task.status === 'failed' || task.status === 'cancelled') && <button className="subtle-button retry" onClick={() => void send(task.request.split('\n\nClarification:')[0]!, false).catch(reportError)}>Try again</button>}
            {!running && <><button className="icon-button" aria-label="Delete this task" title="Delete task" onClick={() => setConfirmDelete(!confirmDelete)}><Icon name="trash" size={16} /></button><button className="icon-button" aria-label="New task" title="New conversation" onClick={() => { setTask(null); taskRef.current = null; setThread([]); setAside(null) }}><Icon name="plus" /></button></>}
          </div>
          {confirmDelete && <div className="delete-confirm"><span>Delete task and undo history? Files stay.</span><button className="danger-button" onClick={() => void deleteTask(task.id).catch(reportError)}>Delete</button><button className="icon-button" aria-label="Cancel deletion" onClick={() => setConfirmDelete(false)}><Icon name="close" size={16} /></button></div>}
          {thread.map((t) => <div className="turn-past" key={t.id}>
            <p className="asked">{t.request}</p>
            <div className="kibu-turn"><div className="kibu-says"><Markdown text={t.summary?.headline ?? t.error ?? t.statusLine} /></div></div>
          </div>)}
          <Reply key={task.id} task={task} onAnswer={answer} onSteps={() => setView('steps')} />
        </section>}
        {view !== 'home' && <div className="page-heading"><button className="icon-button" aria-label="Back home" onClick={() => setView('home')}><Icon name="back" size={17} /></button><h1>{TITLES[view]}</h1>
          {view === 'past' && history.some((r) => !RUNNING.includes(r.status)) && <button className="subtle-button" onClick={() => setConfirmClear(!confirmClear)}>Clear</button>}
        </div>}
        {view === 'past' && confirmClear && <div className="delete-confirm"><span>Delete finished tasks and undo history? Files stay.</span><button className="danger-button" onClick={async () => { try { await window.kibu.clearHistory(); await refreshHistory(); setConfirmClear(false) } catch (e) { reportError(e) } }}>Delete all</button><button className="icon-button" aria-label="Cancel clear history" onClick={() => setConfirmClear(false)}><Icon name="close" size={16} /></button></div>}
        {view === 'steps' && <Steps task={task} logs={task ? logs.filter((l) => l.taskId === task.id) : []} />}
        {view === 'past' && <Past rows={history} onOpen={openTask} onDelete={deleteTask} onUndo={async (id) => { const report = await window.kibu.undoTask(id); await refreshHistory(); return report }} />}
        {(view === 'keys' || view === 'tune') && <Tune only={view === 'keys' ? 'keys' : undefined} onKeyChange={() => void refreshSetup().catch(reportError)} />}
        {view === 'bench' && <Bench rows={bench} running={benching} />}
        {view === 'help' && <div className="help-page"><p className="capability-note">Files · Mac apps · Browser</p>{blind && <button className="permission-link" onClick={() => setView('tune')}>Enable app control →</button>}<ul className="help">{COMMANDS.map((c) => <li key={c.name}><button className="cmd" onClick={() => void command(c.name)}>/{c.name}</button><span className="dim">{c.hint}</span></li>)}</ul></div>}
      </main>
      {running && view !== 'home' && <button className="return-task" onClick={() => setView('home')}><span className="pulse" />{task?.status === 'awaiting_user' ? 'Your input needed' : 'Task in progress'}<Icon name="arrow" size={15} /></button>}
      <footer className="statusbar">
        {running
          ? <span className="status-text is-live"><span className="pulse" />{statusText}</span>
          : <span className="hints" aria-hidden="true"><kbd>↵</kbd>Ask<i /><kbd>/</kbd>Commands{front && <><i /><kbd>⌥↵</kbd>With {front.name}</>}</span>}
        <nav aria-label="Navigation">
          <button className={`icon-button ${view === 'past' ? 'selected' : ''}`} aria-label="History" title="History" onClick={() => void command('past')}><Icon name="clock" size={16} /></button>
          <button className={`icon-button ${view === 'tune' ? 'selected' : ''}`} aria-label="Settings" title={hasKey === false ? 'Settings · connect a model for app and browser tasks' : 'Settings'} onClick={() => setView('tune')}><Icon name="settings" size={16} />{hasKey === false && <i className="connection-dot" />}</button>
          <button className="icon-button" aria-label="Help" title="Help" onClick={() => setView('help')}><Icon name="help" size={16} /></button>
          <span className="nav-rule" />
          <button className={`icon-button ${panel.pinned ? 'selected' : ''}`} aria-label="Keep in front" aria-pressed={panel.pinned} title={panel.pinned ? 'Keep in front: on — click to let other apps cover Kibu' : 'Keep in front: off — other apps can cover Kibu'} onClick={() => void window.kibu.pinPanel(!panel.pinned)}><Icon name="pin" size={16} /></button>
          <button className="icon-button" aria-label="Minimize to island" title="Minimize to the island" onClick={() => void window.kibu.minimizePanel()}><Icon name="minimize" size={16} /></button>
          <button className="icon-button" aria-label="Hide Kibu" title="Hide (Esc)" onClick={() => void window.kibu.closePanel()}><Icon name="close" size={16} /></button>
        </nav>
      </footer>
      <button className="island" aria-label="Open Kibu" title="Open Kibu" tabIndex={panel.docked ? 0 : -1} aria-hidden={!panel.docked} onClick={() => void window.kibu.minimizePanel()}>
        <span className="island-face"><Sprite state={petState} mood={task && !running ? MOOD_FOR[task.petState] : MOOD_FOR[petState]} size={32} /></span>
        <span className="island-text">{islandLine}</span>
        {running ? <span className="island-wave" aria-hidden="true"><i /><i /><i /><i /></span> : <Icon name="expand" size={14} />}
      </button>
      {dragging && <div className="drop-overlay"><Icon name="attach" size={30} /><strong>Drop files</strong></div>}
    </div>
  )
}
