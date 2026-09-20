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
export function createPetWindow(deps: PetWindowDeps, saved: { x: number; y: number }): BrowserWindow {
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
      sandbox: false
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

  win.once('ready-to-show', () => win.showInactive())

  // Dock icon stays hidden: Kibu is an accessory, not a windowed app.
  if (process.platform === 'darwin') app.dock?.hide()

  return win
}

/** Makes the pet solid to the mouse, or lets clicks pass through it again. */
export function setPetInteractive(win: BrowserWindow | null, interactive: boolean): void {
  if (!win || win.isDestroyed()) return
  if (interactive) win.setIgnoreMouseEvents(false)
  else win.setIgnoreMouseEvents(true, { forward: true })
}

export { PET_WIDTH, PET_HEIGHT }
