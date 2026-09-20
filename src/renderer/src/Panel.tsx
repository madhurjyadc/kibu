import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LogEntry, TaskState, TaskSummaryRow } from '../../shared/protocol.js'
import { Composer } from './components/Composer.js'
import { TaskView } from './components/TaskView.js'
import { History } from './components/History.js'
import { SettingsView } from './components/Settings.js'

type Tab = 'task' | 'history' | 'settings'

export function Panel(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('task')
  const [task, setTask] = useState<TaskState | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [dropped, setDropped] = useState<string[]>([])
  const [history, setHistory] = useState<TaskSummaryRow[]>([])
  const [hasKey, setHasKey] = useState(true)
  const [desktopActive, setDesktopActive] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offTask = window.kibu.onTaskUpdate((t) => {
      setTask(t)
      setTab('task')
    })
    const offLog = window.kibu.onLog((entry) => {
      setLogs((prev) => [...prev.slice(-199), entry])
    })
    const offDropped = window.kibu.onDroppedPaths((paths) => {
      setDropped(paths)
      setTab('task')
    })
    const offDesktop = window.kibu.onDesktopSession(setDesktopActive)
    const offFocus = window.kibu.onFocusInput(() => {
      setTab('task')
      document.querySelector<HTMLTextAreaElement>('#composer')?.focus()
    })
    void window.kibu.hasApiKey().then(setHasKey)
    return () => {
      offTask()
      offLog()
      offDropped()
      offDesktop()
      offFocus()
    }
  }, [])

  // The window grows and shrinks with its content rather than scrolling a
  // fixed box, which keeps short answers compact.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      void window.kibu.resizePanel(el.scrollHeight + 16)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const submit = useCallback(
    async (text: string, includeFrontWindow: boolean) => {
      setLogs([])
      const paths = dropped
      setDropped([])
      await window.kibu.startTask({ request: text, droppedPaths: paths, includeFrontWindow })
    },
    [dropped]
  )

  const openHistory = useCallback(async () => {
    setHistory(await window.kibu.listHistory(25))
    setTab('history')
  }, [])

  const running = task ? !['succeeded', 'failed', 'cancelled'].includes(task.status) : false

  return (
    <div className="panel" ref={bodyRef}>
      <header className="panel-head">
        <div className="brand">
          <span className="brand-dot" />
          Kibu
        </div>
        <nav>
          <button className={tab === 'task' ? 'on' : ''} onClick={() => setTab('task')}>
            Task
          </button>
          <button className={tab === 'history' ? 'on' : ''} onClick={openHistory}>
            History
          </button>
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
            Settings
          </button>
        </nav>
        <button className="close" onClick={() => void window.kibu.closePanel()} aria-label="Close">
          ✕
        </button>
      </header>

      {desktopActive && (
        <div className="desktop-banner">
          Kibu is using your screen and keyboard.
          <button onClick={() => void window.kibu.stopDesktopSession()}>Stop</button>
        </div>
      )}

      {!hasKey && tab !== 'settings' && (
        <div className="notice">
          Kibu needs an API key before it can run a task — a TypeSafe (Jev) key for file tasks, an Anthropic key for
          everything else.{' '}
          <button className="link" onClick={() => setTab('settings')}>
            Add it
          </button>
        </div>
      )}

      <div className="panel-body">
        {tab === 'task' && (
          <>
            {task && <TaskView task={task} logs={logs.filter((l) => l.taskId === task.id)} />}
            {!running && (
              <Composer
                droppedPaths={dropped}
                onClearDropped={() => setDropped([])}
                onSubmit={submit}
                placeholder={task ? 'Ask for something else…' : 'What can I do for you?'}
              />
            )}
          </>
        )}
        {tab === 'history' && (
          <History
            rows={history}
            onOpen={async (id) => {
              const t = await window.kibu.getTask(id)
              if (t) {
                setTask(t)
                setTab('task')
              }
            }}
            onUndo={async (id) => {
              const report = await window.kibu.undoTask(id)
              setHistory(await window.kibu.listHistory(25))
              return report
            }}
          />
        )}
        {tab === 'settings' && <SettingsView onKeyChange={setHasKey} />}
      </div>
    </div>
  )
}
