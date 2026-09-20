import { useEffect, useRef, useState } from 'react'
import type { PetState, TaskState } from '../../shared/protocol.js'
import { Sprite } from './components/Sprite.js'

/** Distance in pixels beyond which a mouse-down becomes a drag, not a click. */
const DRAG_THRESHOLD = 4

export function Pet(): React.JSX.Element {
  const [state, setState] = useState<PetState>('idle')
  const [bubble, setBubble] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [desktopActive, setDesktopActive] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const offState = window.kibu.onPetState(setState)
    const offTask = window.kibu.onTaskUpdate((task: TaskState) => {
      // The bubble always reflects real runtime state, never a canned line.
      if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
        setBubble(task.summary?.headline ?? task.statusLine)
        if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
        bubbleTimer.current = setTimeout(() => setBubble(null), 6000)
      } else {
        if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
        setBubble(task.statusLine || null)
      }
    })
    const offDesktop = window.kibu.onDesktopSession(setDesktopActive)
    return () => {
      offState()
      offTask()
      offDesktop()
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
    }
  }, [])

  function onMouseDown(e: React.MouseEvent): void {
    dragRef.current = { startX: e.screenX, startY: e.screenY, moved: false }
  }

  function onMouseMove(e: React.MouseEvent): void {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.screenX - drag.startX
    const dy = e.screenY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    // Move the window by the delta since the last event, then re-anchor.
    drag.startX = e.screenX
    drag.startY = e.screenY
    void window.kibu.dragPet(dx, dy)
  }

  function onMouseUp(): void {
    const drag = dragRef.current
    dragRef.current = null
    // A press that never moved is a click: open the panel.
    if (drag && !drag.moved) void window.kibu.petClicked()
  }

  function onDrop(e: React.DragEvent): void {
    e.preventDefault()
    setDropping(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.kibu.getPathForFile(f))
      .filter(Boolean)
    if (paths.length === 0) return
    // Dropping opens the panel pre-loaded with what was dropped, rather than
    // guessing an action for files the user has said nothing about yet.
    void window.kibu.reportDroppedPaths(paths)
  }

  return (
    <div
      className={`pet-root ${dropping ? 'dropping' : ''}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {bubble && (
        <div className="bubble" role="status">
          {bubble}
        </div>
      )}
      {desktopActive && <div className="control-ring" aria-hidden />}
      <Sprite state={state} />
      {dropping && <div className="drop-hint">Drop to work on these</div>}
    </div>
  )
}
