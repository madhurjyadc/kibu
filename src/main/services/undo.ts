import * as fs from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Store } from './db.js'
import type { UndoReport } from '../../shared/protocol.js'

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Reverses the file operations from one task, newest first.
 *
 * This is deliberately conservative. We only reverse operations we recorded
 * both sides of, and we refuse when the world has moved on — if the file is no
 * longer where we put it, or something now occupies its original path, we skip
 * it and say so. There is no universal undo, and pretending otherwise would be
 * worse than doing nothing.
 */
export async function undoTask(store: Store, taskId: string): Promise<UndoReport> {
  const entries = store.undoableActions(taskId)
  const report: UndoReport = { reversed: 0, skipped: [] }

  for (const { id, undo } of entries) {
    const { from, to } = undo.payload
    try {
      if (undo.kind === 'folder.create') {
        if (!(await exists(to))) {
          report.skipped.push({ path: to, reason: 'folder is already gone' })
          store.markReversed(id)
          continue
        }
        const remaining = await fs.readdir(to)
        if (remaining.length > 0) {
          // Removing a folder that now holds files would destroy data.
          report.skipped.push({ path: to, reason: `folder is not empty (${remaining.length} items)` })
          continue
        }
        await fs.rmdir(to)
        store.markReversed(id)
        report.reversed++
        continue
      }

      // file.move / file.rename: put it back where it came from.
      if (!(await exists(to))) {
        report.skipped.push({ path: to, reason: 'the file is no longer where Kibu put it' })
        continue
      }
      if (await exists(from)) {
        report.skipped.push({ path: from, reason: 'something else now occupies the original path' })
        continue
      }
      await fs.mkdir(dirname(from), { recursive: true })
      await fs.rename(to, from)
      // Confirm the reversal actually landed before recording it as done.
      if (!(await exists(from))) {
        report.skipped.push({ path: from, reason: 'move back did not take effect' })
        continue
      }
      store.markReversed(id)
      report.reversed++
    } catch (err) {
      report.skipped.push({ path: to, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return report
}
