import { Brain, useBrain } from './components/Brain.js'
import { dueItems, timerRemaining, type BrainTimer } from '../../shared/brain.js'
import { Elapsed, Status, clockText, taskStatus } from './components/Dots.js'
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

type View = 'brain' | 'home' | 'steps' | 'past' | 'keys' | 'tune' | 'help' | 'bench'
/** A finished chat left this long is put away: the next summon opens on a fresh launcher. */
const STALE_CHAT_MS = 10 * 60 * 1000
/** How many earlier turns a conversation keeps on screen. */
const MAX_TURNS = 8
const RUNNING = ['pending', 'observing', 'planning', 'executing', 'verifying', 'awaiting_user', 'paused']
const IDEAS: { title: string; prompt: string; icon: IconName; hint: string }[] = [
  { title: 'Find', prompt: 'Find ', icon: 'search', hint: 'a file, by name or what’s in it' },
  { title: 'Organize', prompt: 'Organize my Downloads folder', icon: 'folder', hint: 'a messy folder' },
  { title: 'Rename', prompt: 'Rename these files consistently', icon: 'rename', hint: 'files to one pattern' }
]
/** What a press may land on without moving the window. */
const NO_DRAG = 'button, a, input, textarea, select, label, summary, kbd, [role="button"]:not(.bar-face), .kibu-says, .asked, .said, pre, .ops, .peek, .palette, .chips, .proof, .steps, .pane, .help, .brain, .chat-title'

/** How the creature reacts to a half-typed request. */
function moodForDraft(text: string, fallback: Mood): Mood {
  const t = text.trim().toLowerCase()
  if (!t) return fallback
  if (t.startsWith('/')) return 'wink'
  if (/^(find|where|search|look for|locate)\b/.test(t)) return 'curious'
  if (/\b(please|thanks|thank you|love)\b/.test(t)) return 'happy'
  return 'listening'
}

const TITLES: Record<View, string> = { brain: 'Workspace', home: 'Kibu', past: 'History', steps: 'Steps', tune: 'Settings', keys: 'Connections', help: 'Shortcuts', bench: 'Diagnostics' }

export function Panel(): React.JSX.Element {
  const brain = useBrain()
  useEffect(() => window.kibu.onBrainOpen(() => setView('brain')), [])
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
  const threadRef = useRef(thread)
  threadRef.current = thread
  const taskRef = useRef<TaskState | null>(null)
  const [seed, setSeed] = useState<{ text: string; id: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /** The panel itself is being moved. */
  const [moving, setMoving] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const dock = useRef<HTMLDivElement>(null)
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
  /**
   * One place for task updates. A turn that replies to the one on screen
   * pushes it up into the chat; any other new turn is a new chat.
   */
  const receive = useCallback((t: TaskState) => {
    // A late update for an earlier turn refreshes it in place.
    if (threadRef.current.some((x) => x.id === t.id)) { setThread((turns) => turns.map((x) => x.id === t.id ? t : x)); return }
    const prev = taskRef.current
    // The reply to startTask can arrive after the runtime's first update.
    if (prev?.id === t.id && t.updatedAt < prev.updatedAt) return
    if (prev && prev.id !== t.id) setThread(t.replyTo === prev.id ? [...threadRef.current, prev].slice(-MAX_TURNS) : [])
    taskRef.current = t
    setTask(t)
    if (!RUNNING.includes(t.status)) void refreshHistory().catch(reportError)
  }, [refreshHistory, reportError])

  useEffect(() => {
    const offDeleted = window.kibu.onHistoryDeleted((ids) => {
      setHistory((rows) => rows.filter((r) => !ids.includes(r.id)))
      setThread((turns) => turns.filter((t) => !ids.includes(t.id)))
      setTask((current) => current && ids.includes(current.id) ? null : current)
      if (taskRef.current && ids.includes(taskRef.current.id)) taskRef.current = null
      setLogs((entries) => entries.filter((l) => !ids.includes(l.taskId)))
    })
    const offTask = window.kibu.onTaskUpdate(receive)
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
      // Summoned again long after a chat ended: open on a clean launcher, as
      // Spotlight would. The chat is still one click away in History.
      const last = taskRef.current
      if (last && !RUNNING.includes(last.status) && Date.now() - last.updatedAt > STALE_CHAT_MS) {
        taskRef.current = null; setTask(null); setThread([]); setLogs([])
      }
      document.querySelector<HTMLTextAreaElement>('#composer')?.focus()
    })
    onFocus()
    void refreshHistory().catch(reportError)
    window.addEventListener('focus', onFocus)
    return () => { offSeed(); offDeleted(); offTask(); offLog(); offDropped(); offPet(); offPanel(); offDesktop(); offFocus(); window.removeEventListener('focus', onFocus) }
  }, [receive, refreshHistory, refreshSetup, reportError])

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
      const chrome = [...root.children].filter((c) => c !== el && c.matches('.bar, .reply-dock, .statusbar')).reduce((h, c) => h + (c as HTMLElement).offsetHeight, 0) + 2
      void window.kibu.resizePanel(Math.ceil((content + chrome) / 20) * 20)
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const c of el.children) observer.observe(c)
    if (dock.current) observer.observe(dock.current)
    return () => observer.disconnect()
  }, [view, task?.id, task?.status, task?.question?.id, thread.length, panel.docked, history.length])
  // A new turn lands at the bottom of the chat, the way a reply does anywhere else.
  useEffect(() => {
    setConfirmClear(false); setConfirmDelete(false)
    const el = workspace.current
    el?.scrollTo({ top: view === 'home' && thread.length ? el.scrollHeight : 0 })
  }, [view, task?.id, task?.question?.id, thread.length])

  const answer = useCallback(async (question: UserQuestion, optionId: string | null, text?: string) => {
    if (!task) return
    await window.kibu.answerQuestion({ taskId: task.id, questionId: question.id, optionId, text })
  }, [task])

  /**
   * Sends a message. `followUp` is the turn it replies to — the reply box
   * passes the chat's latest turn — or null to start a new chat.
   */
  const send = useCallback(async (text: string, withFront: boolean, followUp: string | null) => {
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
      const started = await window.kibu.startTask({ request: text, droppedPaths: dropped, includeFrontWindow: withFront, followUp })
      setDropped([])
      setLogs([])
      setSeed(null)
      setView('home')
      if (started) receive(started)
    } finally { sending.current = false }
  }, [dropped, task, running, answer, receive])

  const command = useCallback(async (name: string) => {
    setAside(null)
    try {
      switch (name) {
        case 'new': newChat(); return
        case 'workspace': setView('brain'); return
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

  /** Puts the current chat away and opens the launcher. It stays in History. */
  function newChat(): void {
    if (running) { setAside('Kibu is still working. Stop the task to start a new chat.'); return }
    taskRef.current = null
    setTask(null); setThread([]); setLogs([]); setAside(null); setSeed(null); setConfirmDelete(false)
    setView('home')
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#composer')?.focus())
  }
  /** Suggestions are new intents, so they start a new chat rather than replying. */
  function compose(text: string): void {
    if (!running) newChat()
    setView('home'); setSeed({ text, id: Date.now() })
  }
  async function openTask(id: string): Promise<void> {
    if (running && id !== task?.id) { setAside('Finish or stop your current task before opening another.'); return }
    try {
      const t = await window.kibu.getTask(id)
      if (!t) return
      // Put the conversation back together from the turns each one replied to.
      const turns: TaskState[] = []
      for (let at = t.replyTo; at && turns.length < MAX_TURNS;) {
        const earlier = await window.kibu.getTask(at)
        if (!earlier) break
        turns.unshift(earlier)
        at = earlier.replyTo
      }
      taskRef.current = t; setThread(turns); setTask(t); setView('home')
    } catch (error) { reportError(error) }
  }
  async function deleteTask(id: string): Promise<void> {
    await window.kibu.deleteTask(id)
    setHistory((rows) => rows.filter((r) => r.id !== id))
    setThread((turns) => turns.filter((t) => t.id !== id))
    if (task?.id === id) { setTask(null); taskRef.current = null; setLogs([]) }
  }
  /** Deleting from the chat header removes the whole conversation, not one turn of it. */
  async function deleteChat(): Promise<void> {
    if (!task) return
    for (const t of [...thread, task]) await window.kibu.deleteTask(t.id)
    const ids = new Set([...thread, task].map((t) => t.id))
    setHistory((rows) => rows.filter((r) => !ids.has(r.id)))
    taskRef.current = null; setTask(null); setThread([]); setLogs([]); setConfirmDelete(false)
  }
  // People repeat themselves: the last few things that worked, one tap away.
  const again = [...new Map(history.filter((r) => r.status === 'succeeded').map((r) => [r.request.trim().toLowerCase(), r])).values()].slice(0, 3)
  const homeMood = moodForDraft(draft, MOOD_FOR[petState])
  /** A chat is on screen: the bar names it, and the reply box under it continues it. */
  const chatting = view === 'home' && !!task
  const placeholder = task?.question ? (task.question.allowFreeText ? 'Your answer…' : 'Choose an option above') : running ? 'Kibu is working…' : dropped.length ? 'What should I do with these?' : chatting ? 'Reply to Kibu…' : 'Ask Kibu anything…'

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

  /** The launcher in the bar starts a new chat; the reply box continues this one. */
  function composer(variant: 'launcher' | 'reply'): React.JSX.Element {
    const followUp = variant === 'reply' ? task?.id ?? null : null
    return <Prompt variant={variant} state={petState} placeholder={placeholder} busy={running} canAnswer={!!task?.question?.allowFreeText} seed={seed} dropped={dropped} front={variant === 'launcher' ? front : null}
      onAttach={async () => { try { const paths = await window.kibu.choosePaths(); setDropped((prev) => [...new Set([...prev, ...paths])].slice(0, 200)) } catch (e) { reportError(e) } }}
      onClearDropped={() => setDropped([])} onSend={(text, withFront) => send(text, withFront, followUp)} onCommand={command}
      onNumber={(n) => { const q = task?.question; if (!q || view !== 'home') return false; const option = (q.options ?? [{ id: 'ok', label: 'Go ahead' }])[n - 1]; if (!option) return false; void answer(q, option.id).catch(reportError); return true }}
      onEscape={() => view === 'home' ? void window.kibu.closePanel() : setView('home')} onDraft={setDraft} />
  }

  return (
    <div className={`kibu ${dragging ? 'is-dropping' : ''} ${panel.docked ? 'is-docked' : ''} ${moving ? 'is-moving' : ''} ${view === 'home' && !task ? 'is-home' : ''}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest(NO_DRAG)) void window.kibu.centerPanel() }}
      onKeyDown={(e) => {
        if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); return }
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
      <div className={`bar ${chatting ? 'is-chat' : ''}`}>
        <div className="bar-face" role="button" tabIndex={0} aria-label="Kibu home" title="Home · drag to move · double-click to centre"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView('home') } }}><Sprite state={petState} mood={barMood} size={46} /></div>
        {chatting && task
          ? <div className="chat-head">
              <div className="chat-title" title={(thread[0] ?? task).request}>
                <strong>{firstLine((thread[0] ?? task).request)}</strong>
                <span>{running ? <>{task.status === 'awaiting_user' ? 'Needs your answer' : 'Kibu is on it'}<i />{thread.length + 1} {thread.length ? 'messages' : 'message'}</> : <>{thread.length + 1} {thread.length ? 'messages' : 'message'}<i />{since((thread[0] ?? task).createdAt)}</>}</span>
              </div>
              <button className="icon-button" aria-label="Delete conversation" title="Delete conversation" disabled={running} onClick={() => setConfirmDelete(!confirmDelete)}><Icon name="trash" size={16} /></button>
              <button className="new-chat" aria-label="New chat" title={running ? 'Kibu is still working' : 'Start a new chat (⌘N)'} disabled={running} onClick={newChat}><Icon name="compose" size={15} /><span>New chat</span><kbd>⌘N</kbd></button>
            </div>
          : <div className="bar-input">{composer('launcher')}</div>}
      </div>
      <main className={`workspace ${view === 'home' && !task ? 'home-workspace' : ''}`} ref={workspace}>
        {desktopActive && <div className="driving-line"><span className="live" />Kibu is acting for you<button onClick={() => void window.kibu.stopDesktopSession()}>Stop</button></div>}
        {aside && <div className="notice" role="status"><span>{aside}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setAside(null)}><Icon name="close" size={15} /></button></div>}
        {view === 'home' && dropped.length > 0 && <div className="capture-actions" aria-label="Use attached files"><button onClick={() => compose('Save these for later')}>Keep with Kibu</button><button onClick={() => compose('Read these documents and propose tasks for my Kibu workspace, keeping the source links.')}>Extract tasks</button><button onClick={() => compose('Prepare PDF copies of these files under 2 MB each.')}>Prepare copies</button></div>}
        {view === 'home' && !task && <section className="idle-space">
          <ul className="rows" aria-label="Actions">
            <li><button className="row-button workspace-row" aria-label="Your workspace" onClick={() => setView('brain')}><span className="row-icon"><Icon name="list" size={15} /></span><span className="row-title">Workspace</span><WorkspaceBadge timer={brain.timer} due={dueItems(brain).length} kept={brain.items.filter(i => i.status === 'open').length} /></button></li>{IDEAS.map((idea, i) => <li key={idea.title}><button className="row-button" aria-label={idea.title} style={{ animationDelay: `${i * 40}ms` }} onClick={() => compose(idea.prompt)}><span className="row-icon"><Icon name={idea.icon} size={15} /></span><span className="row-title">{idea.title}</span><span className="row-hint" data-hint={idea.hint} aria-hidden="true" /></button></li>)}</ul>
          {again.length > 0 && <><p className="rows-label">Recent</p><ul className="rows" aria-label="Do again">{again.map((r) => <li key={r.id}><button className="row-button" title={r.request} onClick={() => compose(r.request)}><span className="row-icon"><Icon name="clock" size={15} /></span><span className="row-title again-text">{r.request}</span></button></li>)}</ul></>}
        </section>}
        {chatting && task && <section className="task-page">
          {confirmDelete && <div className="delete-confirm"><span>Delete this conversation and its undo history? Files stay.</span><button className="danger-button" onClick={() => void deleteChat().catch(reportError)}>Delete</button><button className="icon-button" aria-label="Cancel deletion" onClick={() => setConfirmDelete(false)}><Icon name="close" size={16} /></button></div>}
          {thread.map((t) => <div className="turn-past" key={t.id}>
            <p className="asked">{t.request}</p>
            <div className="kibu-turn"><div className="kibu-says"><div className="says-head">Kibu</div><Markdown text={t.summary?.headline ?? t.error ?? t.statusLine} /></div></div>
          </div>)}
          <Reply key={task.id} task={task} badge={!isChat} onAnswer={answer} onSteps={() => setView('steps')} onWorkspace={() => setView('brain')}
            onRetry={() => void send(task.request.split('\n\nClarification:')[0]!, false, task.replyTo ?? null).catch(reportError)} />
        </section>}
        {view !== 'home' && view !== 'brain' && <div className="page-heading"><button className="icon-button" aria-label="Back home" onClick={() => setView('home')}><Icon name="back" size={17} /></button><h1>{TITLES[view]}</h1>
          {view === 'past' && history.some((r) => !RUNNING.includes(r.status)) && <button className="subtle-button" onClick={() => setConfirmClear(!confirmClear)}>Clear</button>}
        </div>}
        {view === 'past' && confirmClear && <div className="delete-confirm"><span>Delete finished tasks and undo history? Files stay.</span><button className="danger-button" onClick={async () => { try { await window.kibu.clearHistory(); await refreshHistory(); setConfirmClear(false) } catch (e) { reportError(e) } }}>Delete all</button><button className="icon-button" aria-label="Cancel clear history" onClick={() => setConfirmClear(false)}><Icon name="close" size={16} /></button></div>}
        {view === 'brain' && <Brain state={brain} onCompose={compose} onBack={() => setView('home')} />}
        {view === 'steps' && <Steps task={task} logs={task ? logs.filter((l) => l.taskId === task.id) : []} />}
        {view === 'past' && <Past rows={history} onOpen={openTask} onDelete={deleteTask} onUndo={async (id) => { const report = await window.kibu.undoTask(id); await refreshHistory(); return report }} />}
        {(view === 'keys' || view === 'tune') && <Tune only={view === 'keys' ? 'keys' : undefined} onKeyChange={() => void refreshSetup().catch(reportError)} />}
        {view === 'bench' && <Bench rows={bench} running={benching} />}
        {view === 'help' && <div className="help-page"><p className="capability-note">Files · Mac apps · Browser</p>{blind && <button className="permission-link" onClick={() => setView('tune')}>Enable app control →</button>}<ul className="help">{COMMANDS.map((c) => <li key={c.name}><button className="cmd" onClick={() => void command(c.name)}>/{c.name}</button><span className="dim">{c.hint}</span></li>)}</ul></div>}
      </main>
      {chatting && <div className="reply-dock" ref={dock}>{composer('reply')}</div>}
      <footer className="statusbar">
        {running && task
          ? view === 'home'
            ? <span className="status-now" role="status"><Status {...taskStatus(task.status)} detail={<Elapsed since={task.createdAt} />} /></span>
            : <button className="status-now is-away" onClick={() => setView('home')} aria-label={`${task.status === 'awaiting_user' ? 'Your input needed' : 'Task in progress'}, back to the task`}>
                <Status {...taskStatus(task.status)} detail={<Elapsed since={task.createdAt} />} /><span className="status-line">{task.status === 'awaiting_user' ? 'Your input needed' : task.statusLine || 'Task in progress'}</span><Icon name="arrow" size={14} /></button>
          : desktopActive
            ? <span className="status-now" role="status"><Status kind="working" label="Driving" /></span>
            : chatting
              ? <span className="hints" aria-hidden="true"><kbd>↵</kbd>Reply<i /><kbd>⌘N</kbd>New chat<i /><kbd>/</kbd>Commands</span>
              : <span className="hints" aria-hidden="true"><kbd>↵</kbd>Ask<i /><kbd>/</kbd>Commands{front && <><i /><kbd>⌥↵</kbd>With {front.name}</>}</span>}
        <nav aria-label="Navigation">
          <button className={`icon-button ${view === 'brain' ? 'selected' : ''}`} aria-label="Workspace" title="Workspace" onClick={() => setView('brain')}><Icon name="list" size={16} /></button>
          <button className={`icon-button ${view === 'past' ? 'selected' : ''}`} aria-label="History" title="History" onClick={() => void command('past')}><Icon name="clock" size={16} /></button>
          <button className={`icon-button ${view === 'tune' ? 'selected' : ''}`} aria-label="Settings" title={hasKey === false ? 'Settings · connect a model for app and browser tasks' : 'Settings'} onClick={() => setView('tune')}><Icon name="settings" size={16} />{hasKey === false && <i className="connection-dot" />}</button>
          <button className="icon-button" aria-label="Help" title="Help" onClick={() => setView('help')}><Icon name="help" size={16} /></button>
          <span className="nav-rule" />
          <button className={`icon-button ${panel.pinned ? 'selected' : ''}`} aria-label="Keep in front" aria-pressed={panel.pinned} title={panel.pinned ? 'Keep in front: on — Kibu stays open when you click elsewhere' : 'Keep in front: off — Kibu tucks away when you click elsewhere'} onClick={() => void window.kibu.pinPanel(!panel.pinned)}><Icon name="pin" size={16} /></button>
          <button className="icon-button" aria-label="Minimize to island" title="Minimize to the island" onClick={() => void window.kibu.minimizePanel()}><Icon name="minimize" size={16} /></button>
          <button className="icon-button" aria-label="Hide Kibu" title="Hide (Esc)" onClick={() => void window.kibu.closePanel()}><Icon name="close" size={16} /></button>
        </nav>
      </footer>
      <button className="island" aria-label="Open Kibu" title="Open Kibu" tabIndex={panel.docked ? 0 : -1} aria-hidden={!panel.docked} onClick={() => void window.kibu.minimizePanel()}>
        <span className="island-face"><Sprite state={petState} mood={task && !running ? MOOD_FOR[task.petState] : MOOD_FOR[petState]} size={32} /></span>
        <span className="island-text">{!running && brain.timer ? <IslandTimer timer={brain.timer} /> : islandLine}</span>
        {running ? <span className="island-wave" aria-hidden="true"><i /><i /><i /><i /></span> : <Icon name="expand" size={14} />}
      </button>
      {dragging && <div className="drop-overlay"><Icon name="attach" size={30} /><strong>Drop files</strong></div>}
    </div>
  )
}

/** Workspace at a glance: the timer if one is running, else what's waiting. */
function WorkspaceBadge({ timer, due, kept }: { timer: BrainTimer | null; due: number; kept: number }): React.JSX.Element | null {
  if (timer) return <span className={`row-badge is-timer is-${timer.status}`}><TimerText timer={timer} /></span>
  if (due) return <span className="row-badge is-due">{due} due</span>
  if (kept) return <span className="row-badge">{kept} kept</span>
  return <span className="row-hint" data-hint="notes, reminders, focus timer" aria-hidden="true" />
}

function IslandTimer({ timer }: { timer: BrainTimer }): React.JSX.Element {
  return <>{timer.label} · <span className="island-clock">{timer.status === 'ringing' ? 'time’s up' : <TimerText timer={timer} />}</span></>
}

/** A countdown that ticks by itself, so the panel does not re-render every second. */
function TimerText({ timer }: { timer: BrainTimer }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (timer.status !== 'running') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [timer.status])
  return <>{timer.status === 'paused' ? `${clockText(timerRemaining(timer, now))} paused` : clockText(timerRemaining(timer, now))}</>
}

/** A chat's name: the first line of what was asked. */
function firstLine(text: string): string {
  return text.split('\n')[0]!.trim()
}

/** When a chat started, the way a person would say it. */
function since(at: number): string {
  const m = Math.floor((Date.now() - at) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
