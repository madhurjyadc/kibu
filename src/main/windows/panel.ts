import { BrowserWindow, screen } from 'electron'
import { PET_HEIGHT, PET_WIDTH } from './pet.js'

const PANEL_WIDTH = 620
/** A compact workspace with independently scrolling content. */
const PANEL_MIN_HEIGHT = 360
const PANEL_MAX_HEIGHT = 660

export interface PanelWindowDeps {
  preload: string
  rendererUrl: string | null
  rendererFile: string
}

/** The companion workspace takes focus while the pet remains on the desktop.
 * The renderer provides navigation, a scrolling workspace, and a pinned composer. */
/** Whether the panel currently has something worth keeping on screen. */
let sticky = false

export function setPanelSticky(value: boolean): void {
  sticky = value
}

export function createPanelWindow(deps: PanelWindowDeps): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: Math.min(440, screen.getPrimaryDisplay().workArea.height - 48),
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

  // Dismiss on click-away only when there is nothing to lose.
  //
  // A popover that vanishes the instant you click elsewhere is unusable for
  // anything that takes time: you cannot read a result, follow a link, or
  // watch it work without destroying it. So it holds its ground whenever it
  // has something to show — a running task, a question, a result, an open
  // pane — and behaves like a launcher only when it is empty.
  win.on('blur', () => {
    if (win.isDestroyed() || !win.isVisible()) return
    if (sticky) return
    win.hide()
  })

  return win
}

/**
 * Centres the panel in the upper third of whichever display the pet is on.
 *
 * It used to hang off the pet's head, which pinned it into a screen corner and
 * forced it narrow. A summoned surface belongs where the eyes already are: the
 * pet stays a desktop creature you click, and what it opens is centre stage.
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
  // A fifth of the way down: the classic summoned-surface placement, and it
  // leaves room for the panel to grow downwards without ever being re-anchored.
  let y = area.y + Math.round(area.height * 0.2)
  y = Math.min(y, area.y + area.height - height - 24)
  y = Math.max(y, area.y + 24)

  panel.setPosition(x, Math.round(y), false)
}

export { PANEL_WIDTH, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT }
