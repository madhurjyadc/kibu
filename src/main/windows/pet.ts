import { BrowserWindow, screen, app } from 'electron'
import { join } from 'node:path'

// Wide enough for the creature to speak in whole words. The window is mostly
// empty space, which is why it ignores the mouse everywhere the creature is
// not — see setPetInteractive.
const PET_WIDTH = 260
const PET_HEIGHT = 190

export interface PetWindowDeps {
  preload: string
  rendererUrl: string | null
  rendererFile: string
}

/**
 * The pet window.
 *
 * It sits above other windows without ever taking focus, so it cannot steal
 * the user's typing. It is transparent and frameless — the visible pet is just
 * what the renderer paints.
 */
export function createPetWindow(deps: PetWindowDeps, saved: { x: number; y: number }, showAtStart = true): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const x = saved.x >= 0 ? saved.x : display.workArea.x + display.workArea.width - PET_WIDTH - 40
  const y = saved.y >= 0 ? saved.y : display.workArea.y + display.workArea.height - PET_HEIGHT - 40

  const win = new BrowserWindow({
    width: PET_WIDTH,
    height: PET_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    // Accepts clicks and file drops, but never becomes the key window.
    focusable: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: deps.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // A transparent, mostly click-through window is easily judged
      // "covered" by macOS, which then throttles its timers and freezes the
      // face mid-expression. The pet is tiny; keep its clock running.
      backgroundThrottling: false
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // A transparent window still swallows every click inside its bounds. Kibu
  // sits on top of everything, so by default it lets the mouse straight
  // through and only becomes solid when the pointer is actually on the
  // creature. Without this, a desktop pet is a dead patch of your screen.
  win.setIgnoreMouseEvents(true, { forward: true })

  const target = deps.rendererUrl ? `${deps.rendererUrl}#pet` : deps.rendererFile
  if (deps.rendererUrl) void win.loadURL(target)
  else void win.loadFile(deps.rendererFile, { hash: 'pet' })

  if (showAtStart) win.once('ready-to-show', () => win.showInactive())

  // Dock icon stays hidden: Kibu is an accessory, not a windowed app.
  if (process.platform === 'darwin') app.dock?.hide()

  return win
}

export interface HitRect { x: number; y: number; width: number; height: number }

/**
 * Whether the pet catches the mouse is decided here, in main, from the real
 * cursor position, rather than by the renderer reacting to forwarded mouse
 * moves. The renderer's way needed a round trip before the window turned
 * solid, so a quick move-and-click landed on the desktop behind the pet and
 * the click was simply lost.
 */
let hitRects: HitRect[] = []
let held = false
let solid = false

function apply(win: BrowserWindow, wanted: boolean): void {
  if (wanted === solid) return
  solid = wanted
  if (wanted) win.setIgnoreMouseEvents(false)
  else win.setIgnoreMouseEvents(true, { forward: true })
}

/** The creature and bubble, in window coordinates, already padded by the renderer. */
export function setPetHitRects(rects: HitRect[]): void {
  hitRects = rects.filter((r) => [r.x, r.y, r.width, r.height].every(Number.isFinite)).slice(0, 4)
}

/** Holds the pet solid through a drag or a file drop, whatever the cursor does. */
export function setPetInteractive(win: BrowserWindow | null, interactive: boolean): void {
  if (!win || win.isDestroyed()) return
  held = interactive
  apply(win, held || solid)
}

/** Called on every cursor sample: solid exactly while the cursor is over the creature. */
export function updatePetHitTest(win: BrowserWindow, cursor: { x: number; y: number }): void {
  const b = win.getBounds()
  const x = cursor.x - b.x
  const y = cursor.y - b.y
  const over = hitRects.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height)
  apply(win, held || over)
}

export { PET_WIDTH, PET_HEIGHT }

/** True while a drag or a file drop is holding the pet solid. */
export function isPetHeld(): boolean {
  return held
}

export { PetPresence, type PetMode } from './pet-presence.js'
