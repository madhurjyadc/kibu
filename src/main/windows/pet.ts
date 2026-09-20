import { BrowserWindow, screen, app } from 'electron'
import { join } from 'node:path'

const PET_WIDTH = 160
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

  const target = deps.rendererUrl ? `${deps.rendererUrl}#pet` : deps.rendererFile
  if (deps.rendererUrl) void win.loadURL(target)
  else void win.loadFile(deps.rendererFile, { hash: 'pet' })

  win.once('ready-to-show', () => win.showInactive())

  // Dock icon stays hidden: Kibu is an accessory, not a windowed app.
  if (process.platform === 'darwin') app.dock?.hide()

  return win
}

export { PET_WIDTH, PET_HEIGHT }
