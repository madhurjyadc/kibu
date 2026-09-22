import { BrowserWindow, screen } from 'electron'
import { PET_HEIGHT, PET_WIDTH } from './pet.js'

const PANEL_WIDTH = 640
/**
 * Spotlight-shaped: the panel can be as short as its command bar plus a few
 * rows, and grows with what it has to show.
 */
const PANEL_MIN_HEIGHT = 120
const PANEL_MAX_HEIGHT = 660

/**
 * Minimized, the panel becomes an island: a small black pill at the top
 * centre of the screen, where the eye already goes for status. It shows what
 * Kibu is doing and opens back out with one click.
 */
const ISLAND_WIDTH = 300
const ISLAND_HEIGHT = 46

export interface PanelWindowDeps {
  preload: string
  rendererUrl: string | null
  rendererFile: string
}

export interface PanelPlacement {
  /** Last position the user left the panel in; -1 means never placed. */
  x: number
  y: number
  /** Whether the panel should float above other applications. */
  pinned: boolean
}

type Bounds = { x: number; y: number; width: number; height: number }

/** Live panel state. There is exactly one panel, so it lives here. */
let docked = false
let pinned = false
/** Where the panel returns to when it is opened back up. */
let expanded: Bounds | null = null

export function isPanelDocked(): boolean {
  return docked
}

export function isPanelPinned(): boolean {
  return pinned
}

/** True while the window is gliding between sizes under its own steam. */
export function isPanelAnimating(): boolean {
  return animation !== null
}

/**
 * The companion workspace takes focus while the pet remains on the desktop.
 *
 * It is an ordinary window in every way that matters to the user: it can be
 * dragged by its header, it stays where it is put, and it stays open when
 * another application comes forward. Whether it floats above that application
 * is the user's choice, not the window's — see setPanelPinned.
 */
export function createPanelWindow(deps: PanelWindowDeps, placement: PanelPlacement): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: Math.min(300, screen.getPrimaryDisplay().workArea.height - 48),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    // The panel is dragged by its whole surface, like Spotlight. Without these,
    // a double-click on that surface would zoom it to fill the screen.
    maximizable: false,
    fullscreenable: false,
    // Kibu is rarely the active app when you reach for it. Without this, the
    // first click on an unfocused panel — including on the minimized handle —
    // only focuses the window and is thrown away, so every button seems to
    // need two clicks.
    acceptFirstMouse: true,
    skipTaskbar: true,
    alwaysOnTop: false,
    hasShadow: true,
    show: false,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: deps.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // A hidden panel keeps rendering, so it is already up to date — right
      // size, latest task — the moment it is shown, instead of flashing an old
      // frame and then catching up.
      backgroundThrottling: false
    }
  })

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  setPanelPinned(win, placement.pinned)
  if (placement.x >= 0 && placement.y >= 0) {
    const bounds = win.getBounds()
    win.setBounds(onScreen({ ...bounds, x: placement.x, y: placement.y }), false)
  }

  if (deps.rendererUrl) void win.loadURL(`${deps.rendererUrl}#panel`)
  else void win.loadFile(deps.rendererFile, { hash: 'panel' })

  return win
}

/**
 * Floats the panel above other applications, or lets them cover it.
 *
 * Unpinned is the default: a window that insists on being frontmost is in the
 * way the moment you want to read anything underneath it.
 */
export function setPanelPinned(win: BrowserWindow, value: boolean): void {
  pinned = value
  if (win.isDestroyed()) return
  // While docked the handle is a few pixels of screen edge; it has to stay
  // visible or there is nothing left to click.
  win.setAlwaysOnTop(value || docked, 'floating')
}

/* ------------------------------------------------------------------ *
 * Motion
 * ------------------------------------------------------------------ */

const FRAME_MS = 1000 / 60
let animation: NodeJS.Timeout | null = null
/** Where the running animation will end, so a resize mid-flight aims there. */
let animTarget: Bounds | null = null
/** True while morphing between panel and island; resizes wait for it. */
let morphing = false
/** A content height that arrived mid-morph, applied once the morph lands. */
let pendingHeight: number | null = null

type Ease = (t: number) => number
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
/** A soft spring: a hair past the target, then settle. */
function easeOutBack(t: number): number {
  const c1 = 1.1
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

/** Glides the window to new bounds instead of teleporting it there. */
function animateBounds(win: BrowserWindow, to: Bounds, duration: number, ease: Ease = easeOutCubic, done?: () => void): void {
  if (animation) clearInterval(animation)
  animTarget = to
  const from = win.getBounds()
  // macOS refuses programmatic resizes while a window declares itself
  // unresizable, so the flag comes off for the length of the move. Nothing is
  // visible to the user: the window is frameless, so there are no grips.
  const wasResizable = win.isResizable()
  if (!wasResizable) win.setResizable(true)
  const started = Date.now()

  const finish = (): void => {
    if (animation) clearInterval(animation)
    animation = null
    animTarget = null
    if (!win.isDestroyed()) {
      win.setBounds(to, false)
      if (!wasResizable) win.setResizable(false)
    }
    done?.()
  }

  animation = setInterval(() => {
    if (win.isDestroyed()) { finish(); return }
    const t = Math.min(1, (Date.now() - started) / duration)
    const k = ease(t)
    win.setBounds(
      {
        x: Math.round(from.x + (to.x - from.x) * k),
        y: Math.round(from.y + (to.y - from.y) * k),
        width: Math.round(from.width + (to.width - from.width) * k),
        height: Math.round(from.height + (to.height - from.height) * k)
      },
      false
    )
    if (t >= 1) finish()
  }, FRAME_MS)
}

/* ------------------------------------------------------------------ *
 * Docking
 * ------------------------------------------------------------------ */

function workAreaFor(win: BrowserWindow): Electron.Rectangle {
  const b = win.getBounds()
  return screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea
}

/** Keeps a window inside the display it is closest to. */
function onScreen(bounds: Bounds): Bounds {
  const area = screen.getDisplayMatching(bounds).workArea
  return {
    ...bounds,
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height))
  }
}

/** The island: top centre of the display the panel is on, just under the menu bar. */
function islandBounds(win: BrowserWindow): Bounds {
  const area = workAreaFor(win)
  return {
    x: area.x + Math.round((area.width - ISLAND_WIDTH) / 2),
    y: area.y + 8,
    width: ISLAND_WIDTH,
    height: ISLAND_HEIGHT
  }
}

/** Shrinks the panel into the island. */
export function dockPanel(win: BrowserWindow): void {
  if (win.isDestroyed() || docked) return
  // If a resize was in flight, the panel's real size is where it was going.
  expanded = animTarget ?? win.getBounds()
  docked = true
  morphing = true
  win.setAlwaysOnTop(true, 'floating')
  animateBounds(win, islandBounds(win), 340, easeInOutCubic, () => { morphing = false })
}

/**
 * Opens the island back into the panel — exactly where it was, at the size
 * its content now needs.
 */
export function undockPanel(win: BrowserWindow): void {
  if (win.isDestroyed() || !docked) return
  docked = false
  morphing = true
  win.setAlwaysOnTop(pinned, 'floating')
  const base = expanded ?? { ...win.getBounds(), width: PANEL_WIDTH, height: 300 }
  const height = pendingHeight ?? base.height
  pendingHeight = null
  expanded = null
  animateBounds(win, onScreen({ ...base, width: PANEL_WIDTH, height }), 380, easeOutBack, () => {
    morphing = false
    // Content that changed size during the morph gets its size now.
    if (pendingHeight !== null) { const h = pendingHeight; pendingHeight = null; resizePanel(win, h) }
  })
}

export function togglePanelDock(win: BrowserWindow): void {
  if (docked) undockPanel(win)
  else dockPanel(win)
}

/**
 * Drops the docked state without any motion.
 *
 * Used when the panel is hidden outright: it should come back as a panel, not
 * as a handle the user has to find and click.
 */
export function resetPanelDock(win: BrowserWindow): void {
  if (!docked) return
  if (animation) { clearInterval(animation); animation = null }
  animTarget = null
  morphing = false
  docked = false
  if (win.isDestroyed()) return
  win.setAlwaysOnTop(pinned, 'floating')
  if (expanded) win.setBounds(onScreen(expanded), false)
  expanded = null
}

/* ------------------------------------------------------------------ *
 * Size and position
 * ------------------------------------------------------------------ */

/** Grows or shrinks the panel in place, without moving it out from under the cursor. */
export function resizePanel(win: BrowserWindow, height: number): void {
  if (win.isDestroyed()) return
  const clamped = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, Math.round(height)))
  // Docked, the request describes a panel nobody can see. Remember it for the
  // moment the handle opens back out.
  if (docked) {
    if (expanded) expanded = onScreen({ ...expanded, height: clamped })
    return
  }
  // Never interrupt the morph: a resize measured mid-flight would restart the
  // animation from a half-open window and leave it stuck small.
  if (morphing) { pendingHeight = clamped; return }
  const bounds = animTarget ?? win.getBounds()
  // Already there, or already on the way there: nothing to do.
  if (bounds.height === clamped) return
  animateBounds(win, onScreen({ ...bounds, height: clamped }), 180)
}

/**
 * Places the panel for its first appearance on an empty desk.
 *
 * Centred in the upper third of whichever display the pet is on: a summoned
 * surface belongs where the eyes already are. Once the user has dragged it
 * somewhere, that position wins and this is never consulted again.
 */
export function positionPanelNearPet(panel: BrowserWindow, pet: BrowserWindow): void {
  const petBounds = pet.getBounds()
  const display = screen.getDisplayNearestPoint({
    x: petBounds.x + PET_WIDTH / 2,
    y: petBounds.y + PET_HEIGHT / 2
  })
  const area = display.workArea
  const { width, height } = panel.getBounds()

  const x = area.x + Math.round((area.width - width) / 2)
  let y = area.y + Math.round(area.height * 0.2)
  y = Math.min(y, area.y + area.height - height - 24)
  y = Math.max(y, area.y + 24)

  panel.setPosition(x, Math.round(y), false)
}

let fade: NodeJS.Timeout | null = null
/** Shows the panel with a quick fade, so it arrives rather than blinks in. */
export function fadeIn(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (fade) clearInterval(fade)
  win.setOpacity(0)
  win.show()
  const started = Date.now()
  fade = setInterval(() => {
    if (win.isDestroyed()) { if (fade) clearInterval(fade); fade = null; return }
    const t = Math.min(1, (Date.now() - started) / 110)
    win.setOpacity(easeOutCubic(t))
    if (t >= 1) { if (fade) clearInterval(fade); fade = null }
  }, FRAME_MS)
}

/**
 * Spotlight behaviour: the panel opens on the display you are working on.
 *
 * Where you dragged it is kept as a position *within* a display, so moving to
 * another monitor brings it to the same spot there instead of leaving it on a
 * screen you are not looking at.
 */
export function placeOnActiveDisplay(panel: BrowserWindow, saved: { x: number; y: number }): void {
  const cursor = screen.getCursorScreenPoint()
  const active = screen.getDisplayNearestPoint(cursor).workArea
  const { width, height } = panel.getBounds()
  const home = screen.getDisplayNearestPoint({ x: saved.x + width / 2, y: saved.y + height / 2 }).workArea
  if (home.x === active.x && home.y === active.y && home.width === active.width) {
    panel.setBounds(onScreen({ x: saved.x, y: saved.y, width, height }), false)
    return
  }
  const fx = (saved.x - home.x) / Math.max(1, home.width - width)
  const fy = (saved.y - home.y) / Math.max(1, home.height - height)
  panel.setBounds(onScreen({
    x: Math.round(active.x + fx * (active.width - width)),
    y: Math.round(active.y + fy * (active.height - height)),
    width,
    height
  }), false)
}

/** Puts the panel back in the default spot on the display under the cursor. */
export function centerPanel(panel: BrowserWindow): void {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const { width, height } = panel.getBounds()
  const x = area.x + Math.round((area.width - width) / 2)
  const y = Math.max(area.y + 24, Math.min(area.y + Math.round(area.height * 0.2), area.y + area.height - height - 24))
  animateBounds(panel, { x, y, width, height }, 220)
}

export { PANEL_WIDTH, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT, ISLAND_WIDTH, ISLAND_HEIGHT }
