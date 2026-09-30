/**
 * Where the pet lives.
 *   peek:    out of sight until there is something to see: it slides up
 *             while Kibu works, needs an answer or runs a timer, stays a few
 *             seconds to show how things went, and comes when called by
 *             resting the pointer on the right edge near the bottom.
 *   menubar: never on the desktop; the menu bar face and notifications.
 *   desktop: always on the desktop, wherever it was put.
 */
export type PetMode = 'peek' | 'menubar' | 'desktop'

/** How long the pet stays to show how a task went. */
const LINGER_MS = 6000
/** How long the pointer rests at the edge before the pet comes. */
const CALL_DWELL_MS = 250
/** How long after the pointer leaves a called pet before it goes. */
const LEAVE_MS = 1200
/** Matches the renderer's exit animation. */
const EXIT_MS = 260

/** The little of a window this needs, so it can be tested without Electron. */
export interface PresenceWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  showInactive(): void
  hide(): void
  getBounds(): { x: number; y: number; width: number; height: number }
}

export interface PresenceDeps {
  win(): PresenceWindow | null
  mode(): PetMode
  /** Tells the renderer to slide in (true) or out (false). */
  presence(visible: boolean): void
  /** The bounds of the display under a point. */
  displayAt(point: { x: number; y: number }): { x: number; y: number; width: number; height: number }
  /** A drag or drop is holding the pet. */
  held(): boolean
  now?(): number
}

export class PetPresence {
  private busy = false
  private attention = false
  private lingerUntil = 0
  private calledUntil = 0
  private edgeSince = 0
  private hideTimer: NodeJS.Timeout | null = null
  private recheck: NodeJS.Timeout | null = null

  constructor(private readonly deps: PresenceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Working, thinking and waiting keep it out; a finished task keeps it a moment longer. */
  setState(state: string): void {
    const wasBusy = this.busy
    this.busy = state === 'thinking' || state === 'working' || state === 'waiting'
    if (!this.busy && (state === 'finished' || state === 'failed' || wasBusy)) this.lingerUntil = this.now() + LINGER_MS
    this.update()
  }

  /** A timer is running or a reminder is due: both are shown on the pet. */
  setAttention(value: boolean): void {
    if (value === this.attention) return
    this.attention = value
    this.update()
  }

  /** Shows the pet for a while, e.g. from the menu bar's "Show pet". */
  showFor(ms: number): void {
    this.calledUntil = this.now() + ms
    this.update()
  }

  /** Every cursor sample, whether or not the pet is showing. */
  sample(cursor: { x: number; y: number }): void {
    const win = this.deps.win()
    if (!win || win.isDestroyed() || this.deps.mode() !== 'peek') return
    const now = this.now()
    const area = this.deps.displayAt(cursor)
    const atEdge = cursor.x >= area.x + area.width - 3 && cursor.y >= area.y + area.height - 260 && cursor.y <= area.y + area.height - 8
    if (atEdge) {
      this.edgeSince ||= now
      if (now - this.edgeSince >= CALL_DWELL_MS) this.calledUntil = now + LEAVE_MS
    } else this.edgeSince = 0
    if (win.isVisible() && this.calledUntil > now) {
      const b = win.getBounds()
      const near = cursor.x >= b.x - 40 && cursor.x <= b.x + b.width + 40 && cursor.y >= b.y - 40 && cursor.y <= b.y + b.height + 40
      if (near || this.deps.held()) this.calledUntil = now + LEAVE_MS
    }
    this.update()
  }

  wanted(): boolean {
    const mode = this.deps.mode()
    if (mode === 'desktop') return true
    if (mode === 'menubar') return false
    const now = this.now()
    return this.busy || this.attention || this.deps.held() || now < this.lingerUntil || now < this.calledUntil
  }

  update(): void {
    const win = this.deps.win()
    if (!win || win.isDestroyed()) return
    const want = this.wanted()
    if (want) {
      if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; this.deps.presence(true) }
      if (!win.isVisible()) { win.showInactive(); this.deps.presence(true) }
    } else if (win.isVisible() && !this.hideTimer) {
      this.deps.presence(false)
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null
        if (!this.wanted() && !win.isDestroyed()) win.hide()
      }, EXIT_MS)
    }
    // Lingering ends by itself, not only on the next event.
    if (this.recheck) clearTimeout(this.recheck)
    const next = Math.max(this.lingerUntil, this.calledUntil) - this.now()
    if (next > 0) this.recheck = setTimeout(() => this.update(), next + 20)
  }
}
