import { BrowserWindow, screen } from 'electron'
import { PET_HEIGHT, PET_WIDTH } from './pet.js'

const PANEL_WIDTH = 400
const PANEL_MIN_HEIGHT = 220
const PANEL_MAX_HEIGHT = 620

export interface PanelWindowDeps {
  preload: string
  rendererUrl: string | null
  rendererFile: string
}

/** The compact task panel. Unlike the pet, this one does take focus: the
 *  user types into it. */
export function createPanelWindow(deps: PanelWindowDeps): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 320,
    minHeight: PANEL_MIN_HEIGHT,
    maxHeight: PANEL_MAX_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
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

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (deps.rendererUrl) void win.loadURL(`${deps.rendererUrl}#panel`)
  else void win.loadFile(deps.rendererFile, { hash: 'panel' })

  // Dismiss on click-away, the way a menu bar popover behaves.
  win.on('blur', () => {
    if (!win.isDestroyed() && win.isVisible()) win.hide()
  })

  return win
}

/** Places the panel beside the pet, kept inside the display's work area. */
export function positionPanelNearPet(panel: BrowserWindow, pet: BrowserWindow): void {
  const petBounds = pet.getBounds()
  const display = screen.getDisplayNearestPoint({ x: petBounds.x, y: petBounds.y })
  const area = display.workArea
  const panelBounds = panel.getBounds()

  // Prefer the left of the pet; flip to the right when there is no room.
  let x = petBounds.x - panelBounds.width - 12
  if (x < area.x + 8) x = petBounds.x + PET_WIDTH + 12
  x = Math.min(x, area.x + area.width - panelBounds.width - 8)
  x = Math.max(x, area.x + 8)

  let y = petBounds.y + PET_HEIGHT / 2 - panelBounds.height / 2
  y = Math.max(area.y + 8, Math.min(y, area.y + area.height - panelBounds.height - 8))

  panel.setPosition(Math.round(x), Math.round(y), false)
}

export { PANEL_WIDTH, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT }
