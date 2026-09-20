import { useState } from 'react'
import type { TaskSummaryRow, UndoReport } from '../../../shared/protocol.js'

export function History({
  rows,
  onOpen,
  onUndo
}: {
  rows: TaskSummaryRow[]
  onOpen(id: string): void | Promise<void>
  onUndo(id: string): Promise<UndoReport>
}): React.JSX.Element {
  const [note, setNote] = useState<Record<string, string>>({})

  if (rows.length === 0) return <p className="muted pad">No tasks yet.</p>

  return (
    <ul className="history">
      {rows.map((r) => (
        <li key={r.id} className={`hist ${r.status}`}>
          <button className="hist-main" onClick={() => void onOpen(r.id)}>
            <span className="hist-request">{r.request}</span>
            <span className="hist-sub">
              {r.headline || r.status} · {new Date(r.createdAt).toLocaleString()}
            </span>
          </button>
          {r.undoable && (
            <button
              className="undo small"
              onClick={async () => {
                const report = await onUndo(r.id)
                setNote((n) => ({
                  ...n,
                  [r.id]: `Put back ${report.reversed}${report.skipped.length ? `, skipped ${report.skipped.length}` : ''}`
                }))
              }}
            >
              Undo
            </button>
          )}
          {note[r.id] && <span className="hist-note">{note[r.id]}</span>}
        </li>
      ))}
    </ul>
  )
}
