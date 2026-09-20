import { useState } from 'react'
import type { TaskSummaryRow, UndoReport } from '../../../shared/protocol.js'
import { isTerminal } from '../../../shared/types.js'
import { Icon } from './Icon.js'

export function Past({ rows, onOpen, onUndo, onDelete }: {
  rows: TaskSummaryRow[]
  onOpen(id: string): void | Promise<void>
  onUndo(id: string): Promise<UndoReport>
  onDelete(id: string): Promise<void>
}): React.JSX.Element {
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  async function remove(id: string): Promise<void> {
    setBusy(true)
    try { await onDelete(id); setDeleting(null) }
    catch (e) { setNote(e instanceof Error ? e.message : 'Couldn’t delete task.') }
    finally { setBusy(false) }
  }
  if (!rows.length) return <p className="pane-empty">No saved tasks.</p>
  return <div className="history-list">
    {note && <p className="notice" role="status">{note}</p>}
    <ul className="past">{rows.map((r) => <li key={r.id}>
      <div className="history-row">
        <span className={`history-dot ${r.status}`} title={r.status} />
        <button className="past-main" onClick={() => void onOpen(r.id)}><span className="past-req">{r.request}</span><time>{relative(r.createdAt)}</time></button>
        {r.undoable && <button className="past-undo" disabled={busy} onClick={async () => {
          setBusy(true)
          try { const report = await onUndo(r.id); setNote(`${report.reversed} restored${report.skipped.length ? ` · ${report.skipped.length} skipped` : ''}`) }
          catch (e) { setNote(e instanceof Error ? e.message : 'Undo failed.') }
          finally { setBusy(false) }
        }}>Undo</button>}
        <button className="icon-button" disabled={busy || !isTerminal(r.status)} aria-label={`Delete ${r.request}`} title={isTerminal(r.status) ? 'Delete task' : 'Stop task before deleting'} onClick={() => setDeleting(deleting === r.id ? null : r.id)}><Icon name="trash" size={15} /></button>
      </div>
      {deleting === r.id && <div className="delete-confirm"><span>Delete task and undo history? Files stay.</span><button className="danger-button" disabled={busy} onClick={() => void remove(r.id)}>Delete</button><button className="icon-button" aria-label="Cancel deletion" disabled={busy} onClick={() => setDeleting(null)}><Icon name="close" size={15} /></button></div>}
    </li>)}</ul>
  </div>
}
function relative(at: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000))
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
