import { useCallback, useEffect, useRef, useState } from 'react'
import type { BenchRow, FrontWindow, LogEntry, PanelState, PetState, TaskState, TaskSummaryRow, UserQuestion } from '../../shared/protocol.js'
import { COMMANDS, Prompt } from './components/Prompt.js'
import { Reply } from './components/Reply.js'
import { Steps } from './components/Steps.js'
import { Past } from './components/Past.js'
import { Tune } from './components/Tune.js'
import { Bench } from './components/Bench.js'
import { Sprite } from './components/Sprite.js'
import { Icon, type IconName } from './components/Icon.js'

type View = 'home' | 'steps' | 'past' | 'keys' | 'tune' | 'help' | 'bench'
const RUNNING = ['pending', 'observing', 'planning', 'executing', 'verifying', 'awaiting_user', 'paused']
const IDEAS: { title: string; prompt: string; icon: IconName }[] = [
  { title: 'Find', prompt: 'Find ', icon: 'search' },
  { title: 'Organize', prompt: 'Organize my Downloads folder', icon: 'folder' },
  { title: 'Rename', prompt: 'Rename these files consistently', icon: 'rename' }
]
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
  const [seed, setSeed] = useState<{ text: string; id: number } | null>(null)
  const [dragging, setDragging] = useState(false)
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
      setTask(t)
      if (!RUNNING.includes(t.status)) void refreshHistory().catch(reportError)
    })
    const offLog = window.kibu.onLog((entry) => setLogs((prev) => [...prev.slice(-199), entry]))
    const offDropped = window.kibu.onDroppedPaths((paths) => { setDropped(paths); setView('home') })
    const offPet = window.kibu.onPetState(setPetState)
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
    return () => { offDeleted(); offTask(); offLog(); offDropped(); offPet(); offPanel(); offDesktop(); offFocus(); window.removeEventListener('focus', onFocus) }
  }, [refreshHistory, refreshSetup, reportError])

  useEffect(() => { void window.kibu.resizePanel(view === 'home' && !task ? 440 : 620) }, [view, task?.id, panel.docked])
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
        case 'steps': case 'keys': case 'tune': setView(name); return
        default: setView('help')
      }
    } catch (error) { reportError(error) }
  }, [task, running, refreshHistory, reportError])

  function compose(text: string): void { setView('home'); setSeed({ text, id: Date.now() }) }
  async function openTask(id: string): Promise<void> {
    if (running && id !== task?.id) { setAside('Finish or stop your current task before opening another.'); return }
    try { const t = await window.kibu.getTask(id); if (t) { setTask(t); setView('home') } } catch (error) { reportError(error) }
  }
  async function deleteTask(id: string): Promise<void> {
    await window.kibu.deleteTask(id)
    setHistory((rows) => rows.filter((r) => r.id !== id))
    if (task?.id === id) { setTask(null); setLogs([]) }
  }
  const placeholder = task?.question ? (task.question.allowFreeText ? 'Your answer…' : 'Choose an option') : running ? 'Working…' : dropped.length ? 'What should I do with these?' : 'Ask Kibu…'

  return (
    <div className={`kibu ${dragging ? 'is-dropping' : ''} ${panel.docked ? 'is-docked' : ''}`}
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
      <header className="app-header">
        <button className="brand" onClick={() => setView('home')} aria-label="Kibu home">kibu<span className="brand-dot" /></button>
        <nav aria-label="Navigation">
          <button className={`icon-button ${view === 'past' ? 'selected' : ''}`} aria-label="History" title="History" onClick={() => void command('past')}><Icon name="clock" /></button>
          <button className={`icon-button ${view === 'tune' ? 'selected' : ''}`} aria-label="Settings" title={hasKey === false ? "Settings · connect a model for app and browser tasks" : "Settings"} onClick={() => setView('tune')}><Icon name="settings" />{hasKey === false && <i className="connection-dot" />}</button>
          <button className="icon-button" aria-label="Help" title="Help" onClick={() => setView('help')}><Icon name="help" /></button>
          <button className={`icon-button ${panel.pinned ? 'selected' : ''}`} aria-label="Keep in front" aria-pressed={panel.pinned} title={panel.pinned ? 'Keep in front: on — click to let other apps cover Kibu' : 'Keep in front: off — other apps can cover Kibu'} onClick={() => void window.kibu.pinPanel(!panel.pinned)}><Icon name="pin" /></button>
          <button className="icon-button" aria-label="Minimize to the edge" title="Minimize to the edge" onClick={() => void window.kibu.minimizePanel()}><Icon name="minimize" /></button>
          <button className="icon-button" aria-label="Hide Kibu" title="Hide" onClick={() => void window.kibu.closePanel()}><Icon name="close" /></button>
        </nav>
      </header>
      <main className={`workspace ${view === 'home' && !task ? 'home-workspace' : ''}`} ref={workspace}>
        {desktopActive && <div className="driving-line"><span className="live" />Controlling your screen<button onClick={() => void window.kibu.stopDesktopSession()}>Stop</button></div>}
        {aside && <div className="notice" role="status"><span>{aside}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setAside(null)}><Icon name="close" size={15} /></button></div>}
        {view === 'home' && !task && <section className="idle-space">
          <div className="orb-stage"><Sprite state={petState} size={164} /></div>
          <div className="quick-actions">{IDEAS.map((idea) => <button key={idea.title} onClick={() => compose(idea.prompt)}><Icon name={idea.icon} size={15} />{idea.title}</button>)}</div>
        </section>}
        {view === 'home' && task && <section className="task-page">
          <div className="task-toolbar"><Sprite state={task.petState} size={35} quiet /><span className="task-status">{task.status === 'awaiting_user' ? 'Your input' : task.status === 'succeeded' ? 'Done' : task.status === 'failed' ? 'Needs attention' : task.status === 'cancelled' ? 'Stopped' : task.status === 'paused' ? 'Paused' : 'Working'}</span>
            {!running && <><button className="icon-button" aria-label="Delete this task" title="Delete task" onClick={() => setConfirmDelete(!confirmDelete)}><Icon name="trash" size={16} /></button><button className="icon-button" aria-label="New task" title="New task" onClick={() => { setTask(null); setAside(null) }}><Icon name="plus" /></button></>}
          </div>
          {confirmDelete && <div className="delete-confirm"><span>Delete task and undo history? Files stay.</span><button className="danger-button" onClick={() => void deleteTask(task.id).catch(reportError)}>Delete</button><button className="icon-button" aria-label="Cancel deletion" onClick={() => setConfirmDelete(false)}><Icon name="close" size={16} /></button></div>}
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
      <footer className="composer-dock">
        <Prompt state={petState} placeholder={placeholder} busy={running} canAnswer={!!task?.question?.allowFreeText} seed={seed} dropped={dropped} front={front}
          onAttach={async () => { try { const paths = await window.kibu.choosePaths(); setDropped((prev) => [...new Set([...prev, ...paths])].slice(0, 200)) } catch (e) { reportError(e) } }}
          onClearDropped={() => setDropped([])} onSend={send} onCommand={command}
          onNumber={(n) => { const q = task?.question; if (!q || view !== 'home') return false; const option = (q.options ?? [{ id: 'ok', label: 'Go ahead' }])[n - 1]; if (!option) return false; void answer(q, option.id).catch(reportError); return true }}
          onEscape={() => view === 'home' ? void window.kibu.closePanel() : setView('home')} />
      </footer>
      <button className="edge-tab" aria-label="Open Kibu" title="Open Kibu" tabIndex={panel.docked ? 0 : -1} aria-hidden={!panel.docked} onClick={() => void window.kibu.minimizePanel()}>
        <Sprite state={running ? petState : 'idle'} size={34} quiet={!running} />
        {running && <span className="pulse" />}
      </button>
      {dragging && <div className="drop-overlay"><Icon name="attach" size={30} /><strong>Drop files</strong></div>}
    </div>
  )
}
