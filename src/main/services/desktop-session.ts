import { BrowserWindow, globalShortcut, screen } from 'electron'
import { EventEmitter } from 'node:events'

/**
 * The exclusive desktop-control session.
 *
 * File work can happen quietly in the background, but driving the GUI means
 * borrowing the user's actual keyboard, mouse and focus. When that is
 * happening it must be visible, interruptible, and held by exactly one task.
 */
export class DesktopSession extends EventEmitter {
  private holder: string | null = null
  private indicator: BrowserWindow | null = null
  private stopAccelerator = 'CommandOrControl+Shift+Escape'

  get activeTaskId(): string | null {
    return this.holder
  }

  get isActive(): boolean {
    return this.holder !== null
  }

  /** Grants control to one task, or rejects if another already holds it. */
  claim(taskId: string, reason: string): void {
    if (this.holder && this.holder !== taskId) {
      throw new Error('another task is already controlling the desktop')
    }
    if (this.holder === taskId) return
    this.holder = taskId
    this.showIndicator(reason)
    this.registerStopShortcut()
    this.emit('changed', true)
  }

  release(taskId: string): void {
    if (this.holder !== taskId) return
    this.holder = null
    this.hideIndicator()
    globalShortcut.unregister(this.stopAccelerator)
    this.emit('changed', false)
  }

  /** The global panic stop. Always available while a session is active. */
  private registerStopShortcut(): void {
    if (globalShortcut.isRegistered(this.stopAccelerator)) return
    globalShortcut.register(this.stopAccelerator, () => {
      this.emit('stop-requested', this.holder)
    })
  }

  private showIndicator(reason: string): void {
    if (this.indicator) {
      this.indicator.webContents.send('desktop:reason', reason)
      return
    }
    const display = screen.getPrimaryDisplay()
    const width = 360
    const height = 48
    this.indicator = new BrowserWindow({
      width,
      height,
      x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      y: display.workArea.y + 12,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      // The indicator must never take focus away from what Kibu is driving.
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })
    this.indicator.setAlwaysOnTop(true, 'screen-saver')
    this.indicator.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.indicator.setIgnoreMouseEvents(true)

    const html = `<!doctype html><meta charset="utf-8"><style>
      :root { color-scheme: dark }
      body { margin:0; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; }
      .bar { display:flex; align-items:center; gap:10px; height:32px; margin:8px;
             padding:0 14px; border-radius:16px; background:rgba(20,20,22,.92);
             color:#fff; box-shadow:0 4px 16px rgba(0,0,0,.35); }
      .dot { width:8px; height:8px; border-radius:50%; background:#34d058;
             animation: pulse 1.4s ease-in-out infinite; }
      .keys { margin-left:auto; opacity:.65; font-size:11px; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
    </style>
    <div class="bar"><span class="dot"></span><span id="r">Kibu is using your screen</span>
    <span class="keys">⌘⇧Esc to stop</span></div>
    <script>
      window.addEventListener('message', e => { document.getElementById('r').textContent = e.data })
    </script>`
    void this.indicator.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    this.indicator.once('ready-to-show', () => this.indicator?.showInactive())
  }

  private hideIndicator(): void {
    this.indicator?.destroy()
    this.indicator = null
  }

  dispose(): void {
    this.hideIndicator()
    globalShortcut.unregister(this.stopAccelerator)
    this.holder = null
  }
}
