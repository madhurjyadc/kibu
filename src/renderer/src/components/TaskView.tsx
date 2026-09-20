import { useState } from 'react'
import type { LogEntry, TaskState } from '../../../shared/protocol.js'
import { QuestionCard } from './QuestionCard.js'
import { Activity } from './Activity.js'
import { basename } from '../lib/paths.js'

const RUNNING = ['pending', 'observing', 'planning', 'executing', 'verifying', 'awaiting_user', 'paused']

export function TaskView({ task, logs }: { task: TaskState; logs: LogEntry[] }): React.JSX.Element {
  const [showActivity, setShowActivity] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [undoNote, setUndoNote] = useState<string | null>(null)
  const running = RUNNING.includes(task.status)
  const verified = task.actions.filter((a) => a.verification?.verified).length

  async function undo(): Promise<void> {
    setUndoing(true)
    try {
      const report = await window.kibu.undoTask(task.id)
      setUndoNote(
        report.reversed === 0 && report.skipped.length === 0
          ? 'There was nothing left to undo.'
          : `Put back ${report.reversed} item${report.reversed === 1 ? '' : 's'}` +
              (report.skipped.length ? `; skipped ${report.skipped.length} (${report.skipped[0]!.reason}).` : '.')
      )
    } finally {
      setUndoing(false)
    }
  }

  return (
    <section className="task">
      <div className="task-request">{task.request}</div>

      <div className={`status-row status-${task.status}`}>
        <span className={`spinner ${running && task.status !== 'paused' && task.status !== 'awaiting_user' ? 'spin' : ''}`} />
        <span className="status-line">{task.statusLine}</span>
        {running && (
          <div className="controls">
            {task.status === 'paused' ? (
              <button onClick={() => void window.kibu.resumeTask(task.id)}>Resume</button>
            ) : (
              <button onClick={() => void window.kibu.pauseTask(task.id)}>Pause</button>
            )}
            <button className="danger" onClick={() => void window.kibu.cancelTask(task.id)}>
              Stop
            </button>
          </div>
        )}
      </div>

      {task.question && <QuestionCard task={task} question={task.question} />}

      {task.summary && !running && (
        <div className={`result ${task.status}`}>
          <div className="result-head">{task.summary.headline}</div>
          {task.error && task.status !== 'succeeded' && <div className="result-error">{task.error}</div>}

          {task.summary.evidence.length > 0 && (
            <ul className="evidence">
              {task.summary.evidence.map((e, i) => (
                <li key={`${e.value}-${i}`}>
                  <span className="ev-label">{e.label}</span>
                  {e.kind === 'path' ? (
                    <span className="ev-actions">
                      <button onClick={() => void window.kibu.openPath(e.value)}>Open</button>
                      <button onClick={() => void window.kibu.revealPath(e.value)}>Reveal</button>
                    </span>
                  ) : (
                    <span className="ev-value" title={e.value}>
                      {e.kind === 'url' ? e.value : basename(e.value)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="result-foot">
            <span className="meta">
              {task.actions.length} step{task.actions.length === 1 ? '' : 's'}
              {verified > 0 && ` · ${verified} verified`}
              {task.cost.usd > 0 && ` · $${task.cost.usd.toFixed(3)}`}
            </span>
            {task.summary.undoable && (
              <button className="undo" onClick={undo} disabled={undoing}>
                {undoing ? 'Undoing…' : 'Undo'}
              </button>
            )}
          </div>
          {undoNote && <div className="undo-note">{undoNote}</div>}
        </div>
      )}

      <button className="activity-toggle" onClick={() => setShowActivity((v) => !v)}>
        {showActivity ? 'Hide' : 'Show'} what Kibu is doing ({task.actions.length})
      </button>
      {showActivity && <Activity task={task} logs={logs} />}
    </section>
  )
}
