import { useBrain, useNow } from './components/Brain.js'
import { dueItems, timerRemaining } from '../../shared/brain.js'
import { clockText } from './components/Dots.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PetPlay, PetState, TaskState } from '../../shared/protocol.js'
import { MOOD_FOR, Sprite, type Look, type Mood } from './components/Sprite.js'
import { plainText } from './components/Markdown.js'
import { SURPRISES, afterFailure, afterSuccess, checkIn, hello, idleRemark, nudge, onStart, reactions, successMood, type Line } from './lib/personality.js'

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

/** A little burst of hearts or sparkles, like the website's playground. */
interface Burst { id: number; kind: 'hearts' | 'sparks'; count: number; color: string }

const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches
/** Back-and-forth passes over the pet, within this window, count as petting. */
const PET_RUBS = 4
const PET_WINDOW_MS = 1400

export function Pet(): React.JSX.Element {
  const [presence, setPresence] = useState<'arriving' | 'leaving' | null>(null)
  const brain = useBrain()
  const now = useNow()
  const timer = brain.timer
  const timerActive = useRef(false)
  timerActive.current = !!timer
  const due = dueItems(brain, now)[0]
  const [alertError, setAlertError] = useState<string | null>(null)
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
  const [bursts, setBursts] = useState<Burst[]>([])
  const [dancing, setDancing] = useState(false)
  const motionRef = useRef<HTMLDivElement>(null)
  const rub = useRef<{ x: number; dir: number; turns: number[] }>({ x: 0, dir: 0, turns: [] })
  const lastPetted = useRef(0)
  const surpriseTurn = useRef(0)
  /** A nap the person asked for lasts until they wake it, not until the cursor wanders by. */
  const chosenNap = useRef(false)
  /** Celebration and sulking both wear off; the pet goes back to being itself. */
  const [settled, setSettled] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean; speed: number; pressedAt: number } | null>(null)
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
    if (optional && (timerActive.current || !chatty.current)) { feel(line.mood, Math.min(ms, 2500)); return }
    if (chatTimer.current) clearTimeout(chatTimer.current)
    setChat(line)
    feel(line.mood, Math.min(ms, 3200))
    chatTimer.current = setTimeout(() => setChat(null), ms)
  }

  function after(ms: number, fn: () => void): void {
    later.current.push(setTimeout(fn, ms))
  }

  /** A little hop, restarted even if one is already playing. */
  function hop(): void {
    const el = motionRef.current
    if (!el || reducedMotion()) return
    el.classList.remove('is-hop')
    void el.offsetWidth
    el.classList.add('is-hop')
  }

  function burst(kind: Burst['kind'], count: number, color = 'var(--lime)'): void {
    if (reducedMotion()) return
    const id = Date.now() + Math.random()
    setBursts((b) => [...b.slice(-3), { id, kind, count, color }])
    after(1300, () => setBursts((b) => b.filter((x) => x.id !== id)))
  }

  function play(action: PetPlay): void {
    lastPoke.current = Date.now()
    if (action === 'dance') {
      chosenNap.current = false
      setAsleep(false)
      setDancing(true)
      say(reactions.danceStart(), 4300)
      feel('music', 4300)
      burst('sparks', 16)
      after(2100, () => burst('sparks', 12, '#e1ff77'))
      after(4300, () => { setDancing(false); say(reactions.danceEnd(), 2600); hop() })
    } else if (action === 'nap') {
      chosenNap.current = true
      say(reactions.nap(), 2400)
      after(900, () => setAsleep(true))
    } else if (action === 'wake') {
      chosenNap.current = false
      setAsleep(false)
      say(reactions.napWake(), 2600)
    } else {
      const line = SURPRISES[surpriseTurn.current++ % SURPRISES.length]!
      say(line, 3200)
      hop()
      if (line.mood === 'starstruck') burst('sparks', 12, '#ffe066')
      if (line.mood === 'kiss') burst('hearts', 7, '#ff6fa8')
    }
  }

  /** Rubbing the cursor back and forth over it is petting: hearts, a happy face, a hop. */
  function noticeRub(clientX: number): void {
    const r = rub.current
    const dx = clientX - r.x
    r.x = clientX
    if (Math.abs(dx) < 3) return
    const dir = Math.sign(dx)
    const now = Date.now()
    if (r.dir !== 0 && dir !== r.dir) r.turns = [...r.turns.filter((t) => now - t < PET_WINDOW_MS), now]
    r.dir = dir
    if (r.turns.length >= PET_RUBS && now - lastPetted.current > 4000) {
      r.turns = []
      lastPetted.current = now
      poke()
      say(reactions.petted(), 2600)
      burst('hearts', 9, '#ff6fa8')
      hop()
    }
  }

  /** Any sign of the person resets the doze timer, and wakes Kibu with a start. */
  function poke(): void {
    lastPoke.current = Date.now()
    if (asleepRef.current && !chosenNap.current) {
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
            const won = successMood(t.actions.length, secs)
            feel(won, 3600)
            if (won === 'celebrate') burst('sparks', 18)
            else if (won === 'starstruck') burst('sparks', 12, '#ffe066')
            else if (t.actions.length > 0) burst('sparks', 8)
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
    const offPlay = window.kibu.onPetPlay((action) => play(action))
    // Out of sight until there is something to see: slide up on arrival, down on leaving.
    const offPresence = window.kibu.onPetPresence((visible) => setPresence(visible ? 'arriving' : 'leaving'))
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
      offDeleted(); offState(); offTask(); offDesktop(); offCursor(); offPlay(); offPresence()
      clearInterval(settingsTimer)
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
      if (chatTimer.current) clearTimeout(chatTimer.current)
      later.current.forEach(clearTimeout)
    }
  }, [])

  // Doze off when nothing has happened for a while, with a yawn first.
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
    if (dancing) return 'music'
    if (flash && flash.until > Date.now()) return flash.mood
    if (asleep && state === 'idle') return 'sleepy'
    if (state === 'working' && straining) return 'straining'
    const resting = settled && (state === 'finished' || state === 'failed')
    if (hovered && (state === 'idle' || state === 'finished' || resting)) return 'happy'
    return resting ? 'idle' : MOOD_FOR[state]
  })()

  function onMouseDown(e: React.MouseEvent): void {
    // Right-click opens the menu; only the left button picks it up.
    if (e.button !== 0) return
    if (bubbleRef.current?.contains(e.target as Node)) return
    // When the button went down, in wall-clock time, so main can ask what the
    // panel was doing *before* this click changed anything.
    dragRef.current = { startX: e.screenX, startY: e.screenY, moved: false, speed: 0, pressedAt: performance.timeOrigin + e.timeStamp }
    armDragWatchdog()
    // A fast drag can outrun the window; stay solid until the button is up.
    hold(true)
  }

  function hold(on: boolean): void {
    if (on === solid.current) return
    solid.current = on
    void window.kibu.setPetInteractive(on)
  }

  /**
   * The window is mostly empty air. Main makes it solid only while the cursor
   * is over the creature or its bubble, from the real cursor position, so
   * the rest stays click-through and a quick click is never lost. This tells
   * main where those are, whenever they move or change size.
   */
  const lastRects = useRef('')
  useLayoutEffect(() => {
    const pad = (el: HTMLElement | null, p: number) => {
      const b = el?.getBoundingClientRect()
      return b ? { x: b.left - p, y: b.top - p, width: b.width + p * 2, height: b.height + p * 2 } : null
    }
    const rects = [pad(hitRef.current, 14), pad(bubbleRef.current, 4)].filter((r): r is NonNullable<typeof r> => r !== null)
    const key = JSON.stringify(rects.map((r) => [r.x, r.y, r.width, r.height].map(Math.round)))
    if (key === lastRects.current) return
    lastRects.current = key
    void window.kibu.setPetHitRects(rects)
  })

  function updateHover(clientX: number, clientY: number): void {
    const box = hitRef.current?.getBoundingClientRect()
    setHovered(!!box && clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom)
  }

  function onMouseMove(e: React.MouseEvent): void {
    updateHover(e.clientX, e.clientY)
    // The button came up somewhere this window never heard about: a fast
    // drag easily leaves the little window behind. Finish the drag now, or
    // Kibu stays dizzy and keeps swallowing clicks on that patch of screen.
    if (dragRef.current && (e.buttons & 1) === 0) { endDrag(); return }
    if (dragRef.current) armDragWatchdog()
    const drag = dragRef.current
    if (!drag) {
      if (hovered) noticeRub(e.clientX)
      return
    }
    const dx = e.screenX - drag.startX
    const dy = e.screenY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    if (!drag.moved) say(reactions.picked(), 1800)
    drag.moved = true
    // Only a real shake makes it dizzy; a gentle carry is fine.
    drag.speed = drag.speed * 0.8 + Math.hypot(dx, dy) * 0.2
    if (drag.speed > 9) setDragging(true)
    drag.startX = e.screenX
    drag.startY = e.screenY
    void window.kibu.dragPet(dx, dy)
  }

  const dragWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** A drag that goes quiet for a while has ended, whether or not the release was seen. */
  function armDragWatchdog(): void {
    if (dragWatchdog.current) clearTimeout(dragWatchdog.current)
    dragWatchdog.current = setTimeout(() => { if (dragRef.current) endDrag() }, 2500)
  }

  /** Ends a drag whose release happened outside the window: no click, just a landing. */
  function endDrag(): void {
    const drag = dragRef.current
    dragRef.current = null
    if (dragWatchdog.current) clearTimeout(dragWatchdog.current)
    hold(false)
    if (drag?.moved) {
      const shaken = dragging
      setDragging(false)
      say(reactions.landed(shaken), 2400)
      hop()
    } else {
      setDragging(false)
    }
  }

  function onMouseUp(e: React.MouseEvent): void {
    if (dragWatchdog.current) clearTimeout(dragWatchdog.current)
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.moved) {
      const shaken = dragging
      setDragging(false)
      say(reactions.landed(shaken), 2400)
      hop()
    }
    hold(false)
    updateHover(e.clientX, e.clientY)
    if (!drag || drag.moved) return
    poke()
    // A few quick taps is affection; a flurry of them tickles. Neither is a
    // request to open the panel.
    const now = Date.now()
    clicks.current = [...clicks.current.filter((t) => now - t < 1500), now]
    if (clicks.current.length >= 6) { clicks.current = []; say(reactions.tickled(), 2600); burst('sparks', 10); hop(); return }
    if (clicks.current.length === 3) { say(reactions.petted(), 2200); burst('hearts', 9, '#ff6fa8'); hop(); return }
    // A click wakes a nap it asked for, without also opening the panel.
    if (asleepRef.current) { chosenNap.current = false; setAsleep(false); say(reactions.napWake(), 2400); return }
    if (clicks.current.length > 1) return
    if (timer) void window.kibu.openBrain()
    else void window.kibu.petClicked(drag.pressedAt)
  }

  function onDrop(e: React.DragEvent): void {
    e.preventDefault()
    setDropping(false)
    hold(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.kibu.getPathForFile(f)).filter(Boolean)
    if (paths.length === 0) return
    say(reactions.fed(paths.length), 1200)
    after(900, () => { say(reactions.ate(paths.length), 2600); burst('sparks', paths.length >= 3 ? 16 : 10); hop() })
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
  const alert = task?.status === 'awaiting_user' ? null : timer?.status === 'ringing' ? `Time’s up: ${timer.label}.` : due ? due.title : null
  // Hovering the TV says what the time is for, without opening anything.
  const peek = hovered && timer && timer.status !== 'ringing' ? `${timer.label} · ${timer.status === 'paused' ? 'paused' : `${clockText(timerRemaining(timer, now))} left`}` : null
  const text = alertError ?? alert ?? peek ?? undoNote ?? chat?.text ?? bubble
  async function alertAction(action: 'done' | 'snooze'): Promise<void> {
    setAlertError(null)
    try {
      if (timer?.status === 'ringing') await window.kibu.brainRequest({ op: 'timer', action: 'cancel' })
      else if (due) await window.kibu.brainRequest(action === 'done' ? { op: 'complete', id: due.id } : { op: 'snooze', id: due.id, minutes: 10 })
    } catch (e) { setAlertError(e instanceof Error ? e.message : 'Could not update reminder.') }
  }

  return (
    <div
      className={`pet-root ${dropping ? 'dropping' : ''} ${desktopActive ? 'driving' : ''} ${presence ? `is-${presence}` : ''}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={(e) => {
        setHovered(false)
        if (!dragRef.current) hold(false)
        // Left the window with the button already up: that drag is over.
        else if ((e.buttons & 1) === 0) endDrag()
      }}
      onMouseUp={onMouseUp}
      onContextMenu={(e) => { e.preventDefault(); hold(false); void window.kibu.showPetMenu(asleep) }}
      onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
      onDragEnter={() => hold(true)}
      onDragLeave={() => { setDropping(false); hold(false) }}
      onDrop={onDrop}
    >
      {text && !dropping && (
        <div key={chat?.text ?? 'status'} className={`bubble ${alert ? 'is-reminder' : peek ? 'is-peek' : tone}`} role="status" ref={bubbleRef}>
          {working && !chat && !peek && !alert && <span className="bubble-pulse" />}
          <span className="bubble-text">{text}</span>
          {alert && <span className="bubble-actions"><button onClick={() => void alertAction('done')}>Done</button>{timer?.status !== 'ringing' && <button onClick={() => void alertAction('snooze')}>10 min</button>}</span>}
          {!alert && !undoNote && chat?.action && (
            <span className="bubble-actions"><button onClick={() => act(chat)}>{chat.action.label}</button></span>
          )}
          {!alert && !peek && !undoNote && !chat && (canUndo || task?.status === 'awaiting_user') && (
            <span className="bubble-actions">
              {task?.status === 'awaiting_user' && <button onClick={() => void window.kibu.petCompose('')}>Answer</button>}
              {canUndo && <button onClick={() => void undo()}>Undo</button>}
            </span>
          )}
        </div>
      )}
      <div className="pet-hit" ref={hitRef}>
        <div className={`pet-motion ${dancing ? 'is-dancing' : ''}`} ref={motionRef} onAnimationEnd={(e) => e.animationName === 'kb-pet-hop' && motionRef.current?.classList.remove('is-hop')}>
          <Sprite state={state} mood={mood} look={look} size={92} timer={timer ? { remainingMs: timerRemaining(timer, now), progress: timerRemaining(timer, now) / timer.durationMs, status: timer.status } : undefined} />
        </div>
      </div>
      <div className="pet-bursts" aria-hidden="true">
        {bursts.map((b) =>
          Array.from({ length: b.count }, (_, i) => {
            const angle = (Math.PI * 2 * i) / b.count - Math.PI / 2
            const dist = 34 + ((i * 37) % 30)
            return (
              <span key={`${b.id}-${i}`} className={`pet-particle is-${b.kind}`}
                style={{ ['--dx' as string]: `${Math.cos(angle) * dist}px`, ['--dy' as string]: `${Math.sin(angle) * dist - 14}px`, ['--spin' as string]: `${(i * 47) % 160}deg`, color: b.color, background: b.kind === 'sparks' ? b.color : undefined, animationDelay: `${(i % 3) * 30}ms` }}>
                {b.kind === 'hearts' ? '♥' : ''}
              </span>
            )
          })
        )}
      </div>
      {dropping && <div className="drop-hint">drop it</div>}
    </div>
  )
}
