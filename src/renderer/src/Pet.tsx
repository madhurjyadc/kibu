import { useEffect, useRef, useState } from 'react'
import type { PetState, TaskState } from '../../shared/protocol.js'
import { MOOD_FOR, Sprite, type Look, type Mood } from './components/Sprite.js'
import { plainText } from './components/Markdown.js'
import { afterFailure, afterSuccess, checkIn, hello, idleRemark, nudge, onStart, reactions, successMood, type Line } from './lib/personality.js'

/** Distance in pixels beyond which a mouse-down becomes a drag, not a click. */
const DRAG_THRESHOLD = 4
/** Left alone this long with nothing to do, Kibu dozes off. */
const SLEEP_AFTER_MS = 3 * 60 * 1000
/** A task running longer than this starts to look like hard work. */
const STRAIN_AFTER_MS = 25 * 1000
/** How often, at most, it speaks up unprompted while idle. */
const REMARK_GAP_MS = [6 * 60 * 1000, 12 * 60 * 1000] as const
const TERMINAL = ['succeeded', 'failed', 'cancelled']

/**
 * A short-lived feeling that overrides the runtime's mood, e.g. surprise at
 * being woken or embarrassment after an undo.
 */
interface Flash { mood: Mood; until: number }

export function Pet(): React.JSX.Element {
  const [state, setState] = useState<PetState>('idle')
  const [task, setTask] = useState<TaskState | null>(null)
  const [bubble, setBubble] = useState<string | null>(null)
  /** Something Kibu chose to say, as opposed to a status line. */
  const [chat, setChat] = useState<Line | null>(null)
  const [dropping, setDropping] = useState(false)
  const [desktopActive, setDesktopActive] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [asleep, setAsleep] = useState(false)
  const [straining, setStraining] = useState(false)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [look, setLook] = useState<Look>({ x: 0, y: 0 })
  const [undoNote, setUndoNote] = useState<string | null>(null)
  /** Celebration and sulking both wear off; the pet goes back to being itself. */
  const [settled, setSettled] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean; speed: number } | null>(null)
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const later = useRef<ReturnType<typeof setTimeout>[]>([])
  const lastPoke = useRef(Date.now())
  const lastMove = useRef(Date.now())
  const activeSince = useRef(Date.now())
  const lastRemark = useRef(Date.now())
  const remarkGap = useRef(REMARK_GAP_MS[0])
  const remarkTurn = useRef(Math.floor(Math.random() * 10))
  const lastHoverHello = useRef(0)
  const chatty = useRef(true)
  const seen = useRef<{ id: string; status: string; nudged: boolean } | null>(null)
  const clicks = useRef<number[]>([])
  const solid = useRef(false)
  const hitRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const asleepRef = useRef(false)
  const working = state === 'working' || state === 'thinking'
  asleepRef.current = asleep

  function feel(mood: Mood, ms: number): void {
    setFlash({ mood, until: Date.now() + ms })
  }

  /** Say something, with the face to match. Optional remarks respect the "chatty" setting. */
  function say(line: Line, ms = 4500, optional = true): void {
    if (optional && !chatty.current) { feel(line.mood, Math.min(ms, 2500)); return }
    if (chatTimer.current) clearTimeout(chatTimer.current)
    setChat(line)
    feel(line.mood, Math.min(ms, 3200))
    chatTimer.current = setTimeout(() => setChat(null), ms)
  }

  function after(ms: number, fn: () => void): void {
    later.current.push(setTimeout(fn, ms))
  }

  /** Any sign of the person resets the doze timer, and wakes Kibu with a start. */
  function poke(): void {
    lastPoke.current = Date.now()
    if (asleepRef.current) {
      setAsleep(false)
      feel('surprised', 700)
      after(700, () => say(reactions.woke(), 2600))
    }
  }

  useEffect(() => {
    const loadSettings = (): void => { void window.kibu.getSettings().then((s) => { chatty.current = s.chatty !== false }).catch(() => {}) }
    loadSettings()
    const settingsTimer = setInterval(loadSettings, 60_000)
    // A hello when it arrives on the desktop.
    after(1400, () => say(hello(new Date().getHours()), 4200))

    const offDeleted = window.kibu.onHistoryDeleted(() => { setBubble(null); setTask(null) })
    const offState = window.kibu.onPetState((s) => { setState(s); poke() })
    const offTask = window.kibu.onTaskUpdate((t: TaskState) => {
      const before = seen.current
      const fresh = !before || before.id !== t.id
      setTask(t)
      setUndoNote(null)
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)

      // A new job: acknowledge it like a person would, before the status lines take over.
      if (fresh && !TERMINAL.includes(t.status)) say(onStart(t.request), 2000)

      // The bubble always reflects real runtime state, never a canned line.
      if (TERMINAL.includes(t.status)) {
        setBubble(plainText(t.summary?.headline ?? t.statusLine))
        // A result with an undo stays up longer: that button is the safety net.
        bubbleTimer.current = setTimeout(() => setBubble(null), t.summary?.undoable ? 12000 : 7000)
        if (before?.status !== t.status) {
          setChat(null)
          if (t.status === 'succeeded') {
            const secs = (t.updatedAt - t.createdAt) / 1000
            feel(successMood(t.actions.length, secs), 3600)
            after(t.summary?.undoable ? 12500 : 7500, () => { const l = afterSuccess(); if (l) say(l, 6000) })
          } else if (t.status === 'failed') {
            after(3500, () => say(afterFailure(), 7000, false))
          }
        }
      } else {
        setBubble(t.statusLine || null)
      }
      seen.current = { id: t.id, status: t.status, nudged: fresh ? false : (before?.nudged ?? false) }
    })
    const offDesktop = window.kibu.onDesktopSession(setDesktopActive)
    // Eyes follow the mouse anywhere on screen, easing off with distance so a
    // far-away cursor gets a glance rather than a stare.
    let lastAt = ''
    const offCursor = window.kibu.onCursor(({ dx, dy }) => {
      const dist = Math.hypot(dx, dy)
      const reach = Math.min(1, dist / 140)
      setLook({ x: dist ? (dx / dist) * reach : 0, y: dist ? (dy / dist) * reach : 0 })
      const at = `${dx},${dy}`
      if (at !== lastAt) {
        const now = Date.now()
        // A long gap means they stepped away; a new stretch of activity starts.
        if (now - lastMove.current > 5 * 60 * 1000) activeSince.current = now
        lastMove.current = now
        lastAt = at
      }
      if (dist < 90) poke()
    })
    return () => {
      offDeleted(); offState(); offTask(); offDesktop(); offCursor()
      clearInterval(settingsTimer)
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
      if (chatTimer.current) clearTimeout(chatTimer.current)
      later.current.forEach(clearTimeout)
    }
  }, [])

  // Doze off when nothing has happened for a while — with a yawn first.
  useEffect(() => {
    const id = setInterval(() => {
      if (state === 'idle' && !hovered && !asleepRef.current && Date.now() - lastPoke.current > SLEEP_AFTER_MS) {
        say(reactions.yawn(), 2600)
        after(2600, () => { if (Date.now() - lastPoke.current > SLEEP_AFTER_MS) setAsleep(true) })
        lastPoke.current = Date.now() - SLEEP_AFTER_MS + 10_000
      }
    }, 5000)
    return () => clearInterval(id)
  }, [state, hovered])

  // The odd unprompted remark: only while idle, awake, and the person is around.
  useEffect(() => {
    if (state !== 'idle') return
    const id = setInterval(() => {
      const now = Date.now()
      if (asleepRef.current || chat || now - lastRemark.current < remarkGap.current || now - lastMove.current > 2 * 60 * 1000) return
      lastRemark.current = now
      remarkGap.current = REMARK_GAP_MS[0] + Math.random() * (REMARK_GAP_MS[1] - REMARK_GAP_MS[0])
      say(idleRemark(new Date().getHours(), (now - activeSince.current) / 60000, remarkTurn.current++), 7000)
    }, 20_000)
    return () => clearInterval(id)
  }, [state, chat])

  // During a long job, a kind word every so often, built from the task's real state.
  useEffect(() => {
    if (!task || TERMINAL.includes(task.status) || task.status === 'awaiting_user') return
    let turn = 0
    const id = setInterval(() => {
      const done = task.plan.filter((p) => p.status === 'done').length
      say(checkIn({ seconds: (Date.now() - task.createdAt) / 1000, done, total: task.plan.length, turn: turn++ }), 4200)
    }, 24_000)
    return () => clearInterval(id)
  }, [task?.id, task?.status])

  // Waiting on an answer for a while: a gentle nudge, once.
  useEffect(() => {
    if (task?.status !== 'awaiting_user') return
    const id = setTimeout(() => {
      if (seen.current && !seen.current.nudged) { seen.current.nudged = true; say(nudge(), 6000) }
    }, 30_000)
    return () => clearTimeout(id)
  }, [task?.status, task?.question?.id])

  // Hovering for a moment without clicking gets a shy hello.
  useEffect(() => {
    if (!hovered || state !== 'idle') return
    const id = setTimeout(() => {
      if (Date.now() - lastHoverHello.current > 5 * 60 * 1000 && !chat) {
        lastHoverHello.current = Date.now()
        say(reactions.hovered(), 2200)
      }
    }, 2500)
    return () => clearTimeout(id)
  }, [hovered, state, chat])

  useEffect(() => {
    setSettled(false)
    if (state !== 'finished' && state !== 'failed') return
    const id = setTimeout(() => setSettled(true), 6000)
    return () => clearTimeout(id)
  }, [state, task?.id])

  // Long jobs show effort.
  useEffect(() => {
    if (state !== 'working') { setStraining(false); return }
    const id = setTimeout(() => setStraining(true), STRAIN_AFTER_MS)
    return () => clearTimeout(id)
  }, [state, task?.id])

  // Now and then, while idle, a little flicker of personality.
  useEffect(() => {
    if (state !== 'idle') return
    let t: ReturnType<typeof setTimeout>
    const quirks: [Mood, number][] = [['wink', 700], ['music', 3200], ['curious', 1400], ['bored', 2600], ['skeptical', 1200]]
    const next = (): void => {
      t = setTimeout(() => {
        if (!asleepRef.current) { const [m, ms] = quirks[Math.floor(Math.random() * quirks.length)]!; feel(m, ms) }
        next()
      }, 22000 + Math.random() * 30000)
    }
    next()
    return () => clearTimeout(t)
  }, [state])

  // Expire flashes.
  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(null), Math.max(0, flash.until - Date.now()))
    return () => clearTimeout(id)
  }, [flash])

  const mood: Mood = (() => {
    if (dropping) return 'excited'
    if (dragging) return 'dizzy'
    if (flash && flash.until > Date.now()) return flash.mood
    if (asleep && state === 'idle') return 'sleepy'
    if (state === 'working' && straining) return 'straining'
    const resting = settled && (state === 'finished' || state === 'failed')
    if (hovered && (state === 'idle' || state === 'finished' || resting)) return 'happy'
    return resting ? 'idle' : MOOD_FOR[state]
  })()

  function onMouseDown(e: React.MouseEvent): void {
    if (bubbleRef.current?.contains(e.target as Node)) return
    dragRef.current = { startX: e.screenX, startY: e.screenY, moved: false, speed: 0 }
  }

  /**
   * The window is mostly empty air. It only catches the mouse while the
   * pointer is actually on the creature or its speech bubble, so the rest of
   * the rectangle stays click-through and Kibu never becomes a dead patch of
   * desktop.
   */
  function updateHitTest(clientX: number, clientY: number): void {
    const pad = 30
    const inside = (el: HTMLElement | null, p: number): boolean => {
      const box = el?.getBoundingClientRect()
      return !!box && clientX >= box.left - p && clientX <= box.right + p && clientY >= box.top - p && clientY <= box.bottom + p
    }
    const over = inside(hitRef.current, pad) || inside(bubbleRef.current, 4)
    setHovered(inside(hitRef.current, 0))
    const wanted = over || dragRef.current !== null || dropping
    if (wanted === solid.current) return
    solid.current = wanted
    void window.kibu.setPetInteractive(wanted)
  }

  function onMouseMove(e: React.MouseEvent): void {
    updateHitTest(e.clientX, e.clientY)
    const drag = dragRef.current
    if (!drag) return
    const dx = e.screenX - drag.startX
    const dy = e.screenY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    // Only a real shake makes it dizzy; a gentle carry is fine.
    drag.speed = drag.speed * 0.8 + Math.hypot(dx, dy) * 0.2
    if (drag.speed > 9) setDragging(true)
    drag.startX = e.screenX
    drag.startY = e.screenY
    void window.kibu.dragPet(dx, dy)
  }

  function onMouseUp(e: React.MouseEvent): void {
    const drag = dragRef.current
    dragRef.current = null
    if (dragging) {
      setDragging(false)
      feel('dizzy', 900)
      if (Math.random() < 0.5) after(900, () => say(reactions.carried(), 2600))
    }
    updateHitTest(e.clientX, e.clientY)
    if (!drag || drag.moved) return
    poke()
    // A few quick taps is affection; a flurry of them tickles. Neither is a
    // request to open the panel.
    const now = Date.now()
    clicks.current = [...clicks.current.filter((t) => now - t < 1500), now]
    if (clicks.current.length >= 6) { clicks.current = []; say(reactions.tickled(), 2600); return }
    if (clicks.current.length === 3) { say(reactions.loved(), 2200); return }
    if (clicks.current.length > 1) return
    void window.kibu.petClicked()
  }

  function onDrop(e: React.DragEvent): void {
    e.preventDefault()
    setDropping(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.kibu.getPathForFile(f)).filter(Boolean)
    if (paths.length === 0) return
    say(reactions.fed(paths.length), 2600)
    void window.kibu.reportDroppedPaths(paths)
  }

  async function undo(): Promise<void> {
    if (!task) return
    try {
      const report = await window.kibu.undoTask(task.id)
      feel('oops', 2600)
      setUndoNote(reactions.undone(report.reversed).text)
      setTask({ ...task, summary: task.summary ? { ...task.summary, undoable: false } : undefined })
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
      bubbleTimer.current = setTimeout(() => { setBubble(null); setUndoNote(null) }, 3500)
    } catch (err) {
      setUndoNote(err instanceof Error ? err.message : 'Couldn’t undo that')
    }
  }

  function act(line: Line): void {
    setChat(null)
    if (line.action?.compose !== undefined) void window.kibu.petCompose(line.action.compose)
    else void window.kibu.petCompose('')
  }

  const done = task && TERMINAL.includes(task.status)
  const tone = chat && !undoNote ? 'is-chat' : !done ? (task?.status === 'awaiting_user' ? 'is-ask' : '') : task.status === 'failed' ? 'is-bad' : task.status === 'succeeded' ? 'is-good' : ''
  const canUndo = !!(done && task.summary?.undoable)
  const text = undoNote ?? chat?.text ?? bubble

  return (
    <div
      className={`pet-root ${dropping ? 'dropping' : ''} ${desktopActive ? 'driving' : ''}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={() => {
        setHovered(false)
        if (solid.current && !dragRef.current) {
          solid.current = false
          void window.kibu.setPetInteractive(false)
        }
      }}
      onMouseUp={onMouseUp}
      onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
      onDragEnter={() => {
        if (!solid.current) { solid.current = true; void window.kibu.setPetInteractive(true) }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {text && !dropping && (
        <div key={chat?.text ?? 'status'} className={`bubble ${tone}`} role="status" ref={bubbleRef}>
          {working && !chat && <span className="bubble-pulse" />}
          <span className="bubble-text">{text}</span>
          {!undoNote && chat?.action && (
            <span className="bubble-actions"><button onClick={() => act(chat)}>{chat.action.label}</button></span>
          )}
          {!undoNote && !chat && (canUndo || task?.status === 'awaiting_user') && (
            <span className="bubble-actions">
              {task?.status === 'awaiting_user' && <button onClick={() => void window.kibu.petCompose('')}>Answer</button>}
              {canUndo && <button onClick={() => void undo()}>Undo</button>}
            </span>
          )}
        </div>
      )}
      <div className="pet-hit" ref={hitRef}>
        <Sprite state={state} mood={mood} look={look} size={92} />
      </div>
      {dropping && <div className="drop-hint">drop it</div>}
    </div>
  )
}
