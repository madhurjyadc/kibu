import { BrowserWindow, screen } from 'electron'
import { PET_HEIGHT, PET_WIDTH } from './pet.js'

const PANEL_WIDTH = 620
/** A compact workspace with independently scrolling content. */
const PANEL_MIN_HEIGHT = 360
const PANEL_MAX_HEIGHT = 660

/**
 * The collapsed handle. Small enough to forget, big enough to hit, and it
 * keeps its flat edge against the side of the screen so it reads as stuck to
 * it rather than floating near it.
 */
const TAB_WIDTH = 54
const TAB_HEIGHT = 128

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
    height: Math.min(440, screen.getPrimaryDisplay().workArea.height - 48),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
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
      sandbox: false
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

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/** Glides the window to new bounds instead of teleporting it there. */
function animateBounds(win: BrowserWindow, to: Bounds, duration: number): void {
  if (animation) clearInterval(animation)
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
    if (!win.isDestroyed()) {
      win.setBounds(to, false)
      if (!wasResizable) win.setResizable(false)
    }
  }

  animation = setInterval(() => {
    if (win.isDestroyed()) { finish(); return }
    const t = Math.min(1, (Date.now() - started) / duration)
    const k = easeOutCubic(t)
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

/** Where the collapsed handle sits: right edge, vertically near where it was. */
function tabBounds(win: BrowserWindow): Bounds {
  const area = workAreaFor(win)
  const current = win.getBounds()
  const middle = current.y + current.height / 2 - TAB_HEIGHT / 2
  return {
    x: area.x + area.width - TAB_WIDTH,
    y: Math.max(area.y + 12, Math.min(Math.round(middle), area.y + area.height - TAB_HEIGHT - 12)),
    width: TAB_WIDTH,
    height: TAB_HEIGHT
  }
}

/** Collapses the panel into the handle on the right edge of the screen. */
export function dockPanel(win: BrowserWindow): void {
  if (win.isDestroyed() || docked) return
  expanded = win.getBounds()
  docked = true
  win.setAlwaysOnTop(true, 'floating')
  animateBounds(win, tabBounds(win), 260)
}

/** Opens the handle back out into the panel. */
export function undockPanel(win: BrowserWindow): void {
  if (win.isDestroyed() || !docked) return
  docked = false
  win.setAlwaysOnTop(pinned, 'floating')
  const target = expanded ? onScreen(expanded) : onScreen({ ...win.getBounds(), width: PANEL_WIDTH, height: 440 })
  expanded = null
  animateBounds(win, target, 240)
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
  const bounds = win.getBounds()
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

export { PANEL_WIDTH, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT, TAB_WIDTH, TAB_HEIGHT }
