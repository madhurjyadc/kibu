import type { LogEntry, TaskState } from '../../../shared/protocol.js'

const OUTCOME_MARK = { success: '✓', failure: '✕', uncertain: '?' } as const

/**
 * The inspectable record: every tool call, its outcome, and whether its
 * effect was independently verified. This is what makes a claim of success
 * checkable rather than something the user has to take on trust.
 */
export function Activity({ task, logs }: { task: TaskState; logs: LogEntry[] }): React.JSX.Element {
  return (
    <div className="activity">
      {task.actions.length === 0 && <p className="muted">Nothing has run yet.</p>}
      <ol>
        {task.actions.map((a) => (
          <li key={a.id} className={`act ${a.outcome}`}>
            <span className="mark">{OUTCOME_MARK[a.outcome]}</span>
            <div className="act-body">
              <span className="tool">{a.tool}</span>
              {a.verification && (
                <span className={`verif ${a.verification.verified ? 'ok' : 'bad'}`}>{a.verification.detail}</span>
              )}
              {a.error && <span className="err">{a.error}</span>}
              {a.outcome === 'uncertain' && (
                <span className="uncertain-note">Result could not be confirmed — Kibu will check before repeating it.</span>
              )}
            </div>
            <span className="dur">{a.finishedAt ? `${((a.finishedAt - a.startedAt) / 1000).toFixed(1)}s` : ''}</span>
          </li>
        ))}
      </ol>

      {task.observations.length > 0 && (
        <details className="observations">
          <summary>What Kibu looked at ({task.observations.length})</summary>
          <ul>
            {task.observations.slice(-8).map((o) => (
              <li key={o.id}>
                <span className="obs-kind">{o.kind}</span> {o.summary}
                <span className="obs-time">{new Date(o.observedAt).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {logs.length > 0 && (
        <details className="logs">
          <summary>Detailed log ({logs.length})</summary>
          <pre>
            {logs
              .slice(-60)
              .map((l) => `${new Date(l.at).toLocaleTimeString()}  ${l.source}: ${l.message}`)
              .join('\n')}
          </pre>
        </details>
      )}
    </div>
  )
}
