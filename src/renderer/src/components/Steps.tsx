import type { LogEntry, TaskState } from '../../../shared/protocol.js'

const MARK = { success: '✓', failure: '✕', uncertain: '?' } as const

/**
 * The receipt: every tool call, its outcome, and whether its effect was
 * independently verified. This is what makes "I did it" checkable instead of
 * something you have to take on trust.
 */
export function Steps({ task, logs }: { task: TaskState | null; logs: LogEntry[] }): React.JSX.Element {
  if (!task) return <p className="pane-empty">I haven’t done anything yet.</p>

  return (
    <div className="pane steps">
      <p className="pane-title">{task.request}</p>
      {task.actions.length === 0 && <p className="pane-empty">Nothing ran.</p>}
      <ol>
        {task.actions.map((a) => (
          <li key={a.id} className={a.outcome}>
            <span className="mark">{MARK[a.outcome]}</span>
            <span className="what">
              <span className="tool">{a.tool}</span>
              {a.verification && <span className={a.verification.verified ? 'dim' : 'bad'}>{a.verification.detail}</span>}
              {a.error && <span className="bad">{a.error}</span>}
              {a.outcome === 'uncertain' && <span className="warn">couldn’t confirm this one — I’ll check before repeating it</span>}
            </span>
            <span className="dim dur">{a.finishedAt ? `${((a.finishedAt - a.startedAt) / 1000).toFixed(1)}s` : ''}</span>
          </li>
        ))}
      </ol>

      {task.observations.length > 0 && (
        <details>
          <summary>what I looked at ({task.observations.length})</summary>
          <ul className="looked">
            {task.observations.slice(-8).map((o) => (
              <li key={o.id}>
                <span className="kind">{o.kind}</span>
                {o.summary}
              </li>
            ))}
          </ul>
        </details>
      )}

      {logs.length > 0 && (
        <details>
          <summary>the whole log ({logs.length})</summary>
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
