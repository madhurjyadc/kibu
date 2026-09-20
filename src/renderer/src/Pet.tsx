import { useEffect, useRef, useState } from 'react'
import type { PetState, TaskState } from '../../shared/protocol.js'
import { Sprite, type Look } from './components/Sprite.js'

/** Distance in pixels beyond which a mouse-down becomes a drag, not a click. */
const DRAG_THRESHOLD = 4

export function Pet(): React.JSX.Element {
  const [state, setState] = useState<PetState>('idle')
  const [bubble, setBubble] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [desktopActive, setDesktopActive] = useState(false)
  const [bubbleTone, setBubbleTone] = useState('')
  const [look, setLook] = useState<Look>({ x: 0, y: 0 })
  const working = state === 'working' || state === 'thinking'
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerInside = useRef(false)
  const solid = useRef(false)
  const hitRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offDeleted = window.kibu.onHistoryDeleted(() => { setBubble(null) })
    const offState = window.kibu.onPetState(setState)
    const offTask = window.kibu.onTaskUpdate((task: TaskState) => {
      // The bubble always reflects real runtime state, never a canned line.
      if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
        setBubbleTone(task.status === 'failed' ? 'is-bad' : task.status === 'succeeded' ? 'is-good' : '')
        setBubble(task.summary?.headline ?? task.statusLine)
        if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
        bubbleTimer.current = setTimeout(() => setBubble(null), 6000)
      } else {
        if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
        setBubbleTone('')
        setBubble(task.statusLine || null)
      }
    })
    const offDesktop = window.kibu.onDesktopSession(setDesktopActive)
    return () => {
      offDeleted()
      offState()
      offTask()
      offDesktop()
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
    }
  }, [])

  // When nobody is pointing at it, the eyes wander a little rather than
  // staring dead ahead.
  useEffect(() => {
    const id = setInterval(() => {
      if (pointerInside.current) return
      setLook({ x: (Math.random() - 0.5) * 1.4, y: (Math.random() - 0.5) * 0.9 })
    }, 3600)
    return () => clearInterval(id)
  }, [])

  function onMouseDown(e: React.MouseEvent): void {
    dragRef.current = { startX: e.screenX, startY: e.screenY, moved: false }
  }

  /**
   * The window is mostly empty air. It only catches the mouse while the
   * pointer is actually on the creature or its speech bubble, so the rest of
   * the rectangle stays click-through and Kibu never becomes a dead patch of
   * desktop.
   */
  function updateHitTest(clientX: number, clientY: number): void {
    const box = hitRef.current?.getBoundingClientRect()
    // Generously inflated: the pointer should find the creature slightly
    // before it reaches it, so that a file being dragged over lands on a
    // window that is already solid rather than one still letting clicks
    // through.
    const pad = 36
    const over =
      !!box &&
      clientX >= box.left - pad &&
      clientX <= box.right + pad &&
      clientY >= box.top - pad &&
      clientY <= box.bottom + pad
    const wanted = over || dragRef.current !== null || dropping
    if (wanted === solid.current) return
    solid.current = wanted
    void window.kibu.setPetInteractive(wanted)
  }

  function onMouseMove(e: React.MouseEvent): void {
    updateHitTest(e.clientX, e.clientY)
    // Eyes follow the cursor while it is over the pet.
    pointerInside.current = true
    const box = e.currentTarget.getBoundingClientRect()
    setLook({
      x: Math.max(-1, Math.min(1, (e.clientX - (box.left + box.width / 2)) / (box.width / 2))),
      y: Math.max(-1, Math.min(1, (e.clientY - (box.top + box.height / 2)) / (box.height / 2)))
    })

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

  function onMouseUp(e: React.MouseEvent): void {
    const drag = dragRef.current
    dragRef.current = null
    updateHitTest(e.clientX, e.clientY)
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
      className={`pet-root ${dropping ? 'dropping' : ''} ${desktopActive ? 'driving' : ''}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={() => {
        pointerInside.current = false
        setLook({ x: 0, y: 0 })
        if (solid.current && !dragRef.current) {
          solid.current = false
          void window.kibu.setPetInteractive(false)
        }
      }}
      onMouseUp={onMouseUp}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragEnter={() => {
        if (!solid.current) {
          solid.current = true
          void window.kibu.setPetInteractive(true)
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {bubble && !dropping && (
        <div className={`bubble ${bubbleTone}`} role="status">
          {working && <span className="bubble-pulse" />}
          <span className="bubble-text">{bubble}</span>
        </div>
      )}
      <div className="pet-hit" ref={hitRef}>
        <Sprite state={dropping ? 'listening' : state} look={look} />
      </div>
      {dropping && <div className="drop-hint">drop them on me</div>}
    </div>
  )
}
