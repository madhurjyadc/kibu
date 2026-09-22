import { useState } from 'react'
import type { Evidence, TaskState, UserQuestion } from '../../../shared/protocol.js'
import { basename } from '../lib/paths.js'
import { Markdown, plainText } from './Markdown.js'
import { Icon } from './Icon.js'

const RUNNING = ['pending', 'observing', 'planning', 'executing', 'verifying', 'awaiting_user', 'paused']

/**
 * What Kibu is saying right now: one line while it works, the question when it
 * stops to ask, the outcome with its evidence when it is done. Everything
 * else — the tool calls, the verifications, the log — lives behind /steps.
 */
export function Reply({
  task,
  onAnswer,
  onSteps
}: {
  task: TaskState
  onAnswer(question: UserQuestion, optionId: string | null, text?: string): Promise<void>
  onSteps(): void
}): React.JSX.Element {
  const [undoing, setUndoing] = useState(false)
  const [undoNote, setUndoNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const running = RUNNING.includes(task.status)
  const verified = task.actions.filter((a) => a.verification?.verified).length
  const summary = task.summary

  async function undo(): Promise<void> {
    setUndoing(true)
    try {
      const report = await window.kibu.undoTask(task.id)
      setUndoNote(
        report.reversed === 0 && report.skipped.length === 0
          ? 'Nothing to undo.'
          : `${report.reversed} restored` +
              (report.skipped.length ? `, left ${report.skipped.length} alone — ${report.skipped[0]!.reason}` : '')
      )
    } catch (error) {
      setUndoNote(error instanceof Error ? error.message : 'Couldn’t undo that change.')
    } finally {
      setUndoing(false)
    }
  }

  return (
    <div className={`reply status-${task.status}`}>
      <p className="asked">{task.request}</p>
      <div className="kibu-turn">
      <div className="kibu-says">
        <div className="says-head"><i className="says-led" />Kibu{!running && <span>{took(task)}</span>}</div>

      {!running && !summary && <p className="said">{task.error || task.statusLine || "Task ended."}</p>}
      {running && task.plan.length > 0 && <details><summary>Plan</summary><ol className="task-plan">{task.plan.map((step) => <li key={step.id} className={step.status}><span>{step.status === "done" ? "✓" : step.status === "active" ? "◉" : "○"}</span>{step.description}</li>)}</ol></details>}

      {running && !task.question && (
        <p className="saying">
          <span className="pulse" />
          <span>{task.statusLine || 'thinking'}</span>
          <span className="say-actions">
            {task.status === 'paused' ? (
              <button onClick={() => void window.kibu.resumeTask(task.id)}>Resume</button>
            ) : (
              <button onClick={() => void window.kibu.pauseTask(task.id)}>Pause</button>
            )}
            <button onClick={() => void window.kibu.cancelTask(task.id)}>Stop</button>
          </span>
        </p>
      )}

      {running && <button className="trace-link" onClick={onSteps}>Details</button>}

      {task.question && (
        <Ask key={task.question.id} question={task.question} onAnswer={onAnswer} onLeave={() => void window.kibu.cancelTask(task.id)} />
      )}

      {summary && !running && (
        <>
          <Markdown text={summary.headline} className={summary.headline.length < 90 && !summary.headline.includes('\n') ? 'is-short' : ''} />
          {task.error && task.status !== 'succeeded' && <p className="said bad">{task.error}</p>}

          {summary.undoable && <p className="safety-net">Changed your mind? Everything I moved can go back.</p>}
          {summary.evidence.length > 0 && (
            <ul className="proof">
              {summary.evidence.map((e, i) => (
                <Proof key={`${e.value}-${i}`} evidence={e} />
              ))}
            </ul>
          )}

          <p className="trace answer-foot">
            <button className="foot-btn" aria-label={copied ? 'Copied' : 'Copy answer'} title="Copy" onClick={() => void navigator.clipboard.writeText(plainText(summary.headline)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})}>
              <Icon name={copied ? 'check' : 'copy'} size={14} />{copied ? 'Copied' : 'Copy'}
            </button>
            {task.actions.length > 0 && <button className="foot-btn" onClick={onSteps}><Icon name="list" size={14} />{task.actions.length} step{task.actions.length === 1 ? '' : 's'}</button>}
            {summary.undoable && (
              <button className="undo" onClick={undo} disabled={undoing}>
                {undoing ? 'Undoing…' : 'Undo'}
              </button>
            )}
          </p>
          {undoNote && (
            <p className="trace">
              <span>{undoNote}</span>
            </p>
          )}
        </>
      )}
      </div>
      </div>
    </div>
  )
}

/** How long the task took, the way a person would say it. */
function took(task: TaskState): string {
  const s = Math.max(0, Math.round((task.updatedAt - task.createdAt) / 1000))
  return s < 1 ? 'instantly' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * One piece of evidence.
 *
 * A path is a thing you open, so the row is a target with its action on the
 * right. Text is something to read, so it gets the full width and wraps —
 * squeezing prose into a right-hand column is what made these unreadable.
 */
function Proof({ evidence }: { evidence: Evidence }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  async function open(reveal = false): Promise<void> {
    try {
      setError(null)
      if (evidence.kind === 'url') await window.kibu.openUrl(evidence.value)
      else if (reveal) await window.kibu.revealPath(evidence.value)
      else await window.kibu.openPath(evidence.value)
    } catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t open this result.') }
  }
  if (evidence.kind === 'text') {
    return (
      <li className="proof-text">
        <span className="proof-label">{evidence.label}</span>
        <span className="proof-body">{evidence.value}</span>
      </li>
    )
  }
  if (evidence.kind === 'url') {
    return (
      <li className="proof-row">
        <span className="proof-glyph">↗</span>
        <button className="proof-main is-link" onClick={() => void open()} title={evidence.value}>{evidence.label}</button>
        <span className="proof-side" title={evidence.value}>
          {evidence.value}
        </span>
        {error && <span className="bad" role="alert">{error}</span>}
      </li>
    )
  }
  return (
    <li className="proof-row">
      <span className="proof-glyph">›</span>
      <button className="proof-main is-link" onClick={() => void open()} title={evidence.value}>
        {evidence.label}
      </button>
      <button className="proof-side" onClick={() => void open(true)}>
        Reveal
      </button>
      {error && <span className="bad" role="alert">{error}</span>}
    </li>
  )
}

/**
 * Where Kibu stops and asks. Two cases share this: a real ambiguity, and a
 * request to widen what it is allowed to touch — the second says so plainly.
 * Answers are one keystroke: the options are numbered.
 */
function Ask({
  question,
  onAnswer,
  onLeave
}: {
  question: UserQuestion
  onAnswer(question: UserQuestion, optionId: string | null, text?: string): Promise<void>
  onLeave(): void
}): React.JSX.Element {
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const ops = question.preview?.fileOps ?? []
  const options = question.options ?? [{ id: 'ok', label: 'go ahead' }]

  async function answer(optionId: string | null): Promise<void> {
    if (sent) return
    setSent(true)
    try { await onAnswer(question, optionId) } catch (err) { setSent(false); setError(err instanceof Error ? err.message : 'Couldn’t send your answer.') }
  }

  return (
    <div className={`ask reason-${question.reason}`}>
      <p className="said">{question.prompt}</p>

      {question.preview && (
        <div className="peek">
          <strong>{question.preview.title}</strong>
          {question.preview.note && <p className="peek-note">{question.preview.note}</p>}
          {ops.length > 0 && (
            <ul className="ops">
              {ops.slice(0, expanded ? ops.length : 10).map((op, i) => (
                <li key={`${op.from}-${i}`}>
                  <span className="op-from" title={op.from}>
                    {basename(op.from)}
                  </span>
                  <span className="op-to" title={op.to}>
                    → {op.kind === 'rename' || op.from.slice(0, op.from.lastIndexOf('/')) === op.to.slice(0, op.to.lastIndexOf('/')) ? basename(op.to) : op.to}
                  </span>
                </li>
              ))}
              {ops.length > 10 && <li><button className="trace-link" onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer" : `Show all ${ops.length} changes`}</button></li>}
            </ul>
          )}
        </div>
      )}

      {error && <p className="bad" role="alert">{error}</p>}
      <div className="options">
        {options.map((o, i) => (
          <button
            key={o.id}
            className={i === 0 ? 'on' : ''}
            onClick={() => void answer(o.id)}
            disabled={sent}
            title={o.detail}
          >
            <span className="num">{i + 1}</span>
            {o.label}
          </button>
        ))}
      </div>
      <p className="trace">
        
        {sent && <span>Sent</span>}
        <button className="trace-link leave" onClick={onLeave}>
          Cancel
        </button>
      </p>
    </div>
  )
}
