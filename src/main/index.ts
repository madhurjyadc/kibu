import { externalWebUrl } from '../shared/web-url.js'
import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, dialog, Tray, Menu, nativeImage, Notification, powerMonitor } from 'electron'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { BrainStore } from './services/brain.js'
import { Store } from './services/db.js'
import { Secrets } from './services/secrets.js'
import { settingsFromSaved } from './services/settings.js'
import { AppUninstaller } from './services/uninstall.js'
import { RuntimeHost } from './services/runtime-host.js'
import { DesktopSession } from './services/desktop-session.js'
import { startUpdateChecks } from './services/updates.js'
import { Setup, isSetupId } from './services/setup.js'
import { undoTask } from './services/undo.js'
import { PetPresence, createPetWindow, isPetHeld, setPetHitRects, setPetInteractive, updatePetHitTest } from './windows/pet.js'
import type { BrainSnapshot } from '../shared/brain.js'
import {
  createPanelWindow,
  positionPanelNearPet,
  resizePanel,
  setPanelPinned,
  togglePanelDock,
  placeOnActiveDisplay,
  centerPanel,
  fadeIn,
  resetPanelDock,
  isPanelDocked,
  isPanelPinned,
  isPanelAnimating
} from './windows/panel.js'
import { createOsAdapter } from '../os/index.js'
import { IPC, DEFAULT_MODEL_CONFIG, DEFAULT_SETTINGS, validCodingModel } from '../shared/protocol.js'
import type {
  AnswerQuestionRequest,
  BenchRow,
  CodingApp,
  FrontWindow,
  LogEntry,
  PetPlay,
  PreviousTurn,
  RuntimeToHost,
  Settings,
  StartTaskRequest
} from '../shared/protocol.js'
import { isTerminal, defaultLimits, emptyAuthorization, type PetState, type TaskState } from '../shared/types.js'
import { normalizePath } from '../runtime/authorization.js'
import { wouldLaunch } from '../runtime/tools/shell.js'
import { claudeCodeAvailable } from '../runtime/model/claude-code-planner.js'
import { codingAppAvailable, codingAppStatus } from '../runtime/model/coding-apps.js'
import { codingModels } from '../runtime/model/coding-models.js'
import { checkCodingModel } from '../runtime/model/coding-model-check.js'

const isDev = !app.isPackaged
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL ?? null

let brain: BrainStore
let brainClock: ReturnType<typeof setInterval> | null = null
let brainSleeping = false
let brainLocked = false
let store: Store
let secrets: Secrets
let runtime: RuntimeHost
let desktopSession: DesktopSession
let petWindow: BrowserWindow | null = null
/** Decides when the pet is on screen; see PetPresence. */
const petPresence = new PetPresence({
  win: () => petWindow,
  mode: () => settings.petMode,
  presence: (visible) => { if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send(IPC.onPetPresence, visible) },
  displayAt: (point) => screen.getDisplayNearestPoint(point).bounds,
  held: isPetHeld
})
let panelWindow: BrowserWindow | null = null
let tray: Tray | null = null
let currentTask: TaskState | null = null
let settings: Settings = { ...DEFAULT_SETTINGS }
let osAdapter: ReturnType<typeof createOsAdapter>
let setup: Setup
let uninstaller: AppUninstaller
/** Set during shutdown so the runtime's exit is not reported as a crash. */
let quitting = false
let runtimeIdleTimer: ReturnType<typeof setTimeout> | null = null
let measuring = false

/** Keep only the shortcut/reminder host alive after the workspace is put away. */
function restRuntime(): void {
  if (runtimeIdleTimer) clearTimeout(runtimeIdleTimer)
  runtimeIdleTimer = null
  if (quitting || measuring || panelWindow?.isVisible() || (currentTask && !isTerminal(currentTask.status))) return
  runtimeIdleTimer = setTimeout(() => {
    runtimeIdleTimer = null
    if (!quitting && !measuring && !panelWindow?.isVisible() && (!currentTask || isTerminal(currentTask.status))) void runtime.stop()
  }, 1000)
}
/**
 * The window the user was in just before Kibu's panel took focus. Captured
 * eagerly because once the panel is open, the frontmost app is Kibu.
 */
let lastFrontWindow: FrontWindow | null = null

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

function resourcePath(...parts: string[]): string {
  return isDev ? join(app.getAppPath(), ...parts) : join(process.resourcesPath, ...parts)
}

function paths() {
  const userData = app.getPath('userData')
  const out = join(app.getAppPath(), 'out')
  // electron-vite emits an ESM preload as .mjs; older configs emit .js.
  const preloadMjs = join(out, 'preload', 'index.mjs')
  return {
    userData,
    helper: resourcePath('resources', 'bin', 'kibu-helper'),
    runtimeEntry: join(out, 'main', 'runtime.js'),
    browserProfile: join(userData, 'browser-profile'),
    downloads: join(userData, 'downloads'),
    preload: existsSync(preloadMjs) ? preloadMjs : join(out, 'preload', 'index.js'),
    rendererFile: join(out, 'renderer', 'index.html')
  }
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

function loadSettings(): Settings {
  return settingsFromSaved(store.getSetting('settings'))
}

function saveSettings(next: Partial<Settings>): Settings {
  settings = { ...settings, ...next }
  store.setSetting('settings', JSON.stringify(settings))
  return settings
}

/* ------------------------------------------------------------------ *
 * Broadcast helpers
 * ------------------------------------------------------------------ */

function broadcast(channel: string, payload: unknown): void {
  // A running timer or a due reminder is shown on the pet, so it comes out for them.
  if (channel === IPC.onBrain) {
    const state = payload as BrainSnapshot
    petPresence.setBrain(state)
  }
  for (const win of [petWindow, panelWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * The pet's eyes follow the mouse across the whole screen, not just while it
 * is over the pet: being noticed is most of what makes it feel alive. The
 * renderer cannot see the global cursor, so main samples it and sends only
 * changes, and only while the pet is on screen.
 */
function followCursor(): void {
  let last = ''
  const timer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) return clearInterval(timer)
    if (!petWindow.isVisible() && settings.petMode !== 'peek') return
    const at = screen.getCursorScreenPoint()
    // Resting the pointer at the screen's right edge calls a tucked-away pet.
    petPresence.sample(at)
    if (!petWindow.isVisible()) return
    // The same sample decides whether the pet catches the mouse, so it is
    // already solid by the time the pointer reaches it.
    updatePetHitTest(petWindow, at)
    const b = petWindow.getBounds()
    const dx = Math.round(at.x - (b.x + b.width / 2))
    const dy = Math.round(at.y - (b.y + b.height * 0.62))
    const key = `${dx},${dy}`
    if (key === last) return
    last = key
    petWindow.webContents.send(IPC.onCursor, { dx, dy })
  }, 30)
}

/** A result headline as notification text: markdown marks dropped, one short paragraph. */
function plainHeadline(markdown: string): string {
  const text = markdown.replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()
  return text.length > 180 ? `${text.slice(0, 177)}…` : text
}

/** What the menu bar says next to Kibu's face while it works, when there is no pet to say it. */
const TRAY_TITLE: Partial<Record<PetState, string>> = { thinking: 'Thinking', working: 'Working', waiting: 'Needs you' }

function setPetState(state: PetState): void {
  broadcast(IPC.onPetState, state)
  petPresence.setState(state)
  tray?.setTitle(settings.petMode === 'menubar' ? TRAY_TITLE[state] ?? '' : '')
}

/* ------------------------------------------------------------------ *
 * Task lifecycle
 * ------------------------------------------------------------------ */

/**
 * Builds the initial authorization for a task.
 *
 * Dropping files onto the pet is itself an act of authorization: it names
 * exactly what the user means. Nothing else is granted up front; anything
 * wider has to be asked for, in context, while the task runs.
 */
function seedAuthorization(req: StartTaskRequest) {
  const auth = emptyAuthorization()
  auth.capabilities = ['user.interact', 'files.read']
  for (const p of req.droppedPaths ?? []) {
    const path = normalizePath(p)
    auth.readRoots.push(path)
    auth.writeRoots.push(path)
    // A dropped file implies its folder is the working area.
    auth.readRoots.push(dirname(path))
  }
  return auth
}

function newTask(req: StartTaskRequest): TaskState {
  const now = Date.now()
  return {
    id: randomUUID(),
    request: req.request,
    outcome: '',
    status: 'pending',
    petState: 'thinking',
    authorization: seedAuthorization(req),
    limits: { ...defaultLimits(), maxUsd: settings.maxUsdPerTask },
    observations: [],
    plan: [],
    actions: [],
    cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    completionCriteria: [],
    statusLine: 'Getting started',
    createdAt: now,
    updatedAt: now
  }
}

/** Whether any planning route at all is configured. */
function canWork(): boolean {
  return secrets.hasApiKey() || secrets.hasJevKey() || (settings.useClaudeCode && codingAppAvailable(settings.codingApp))
}

/**
 * How long a finished task stays available as context for the next message.
 * Long enough that a follow-up lands in the same conversation, short enough
 * that tomorrow's request is not coloured by yesterday's.
 */
const FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000
/** How many turns before the one replied to are given to the model as well. */
const EARLIER_TURNS = 5
let lastFinished: { id: string; request: string; headline: string; at: number } | null = null

/**
 * What this message follows. A reply names its turn, so it is context however
 * long ago that was; a new chat has none; anything else falls back to the
 * follow-up window.
 */
function previousTurn(followUp: string | null | undefined): PreviousTurn | null {
  if (followUp === null) return null
  if (followUp) {
    const thread = store.conversationOf(followUp)
    const at = thread.findIndex((t) => t.id === followUp)
    const prior = thread[at]
    if (!prior) return null
    const said = (t: TaskState): string => t.summary?.headline ?? t.error ?? t.statusLine
    return {
      request: prior.request,
      headline: said(prior),
      secondsAgo: Math.max(0, Math.round((Date.now() - prior.updatedAt) / 1000)),
      explicit: true,
      // The rest of the chat up to that turn, so a reply has the whole thread.
      earlier: thread.slice(Math.max(0, at - EARLIER_TURNS), at).map((t) => ({ request: t.request, headline: said(t) }))
    }
  }
  if (!lastFinished) return null
  const elapsed = Date.now() - lastFinished.at
  if (elapsed > FOLLOW_UP_WINDOW_MS) return null
  return {
    request: lastFinished.request,
    headline: lastFinished.headline,
    secondsAgo: Math.round(elapsed / 1000)
  }
}

async function startTask(req: StartTaskRequest): Promise<TaskState> {
  if (uninstaller.inProgress) throw new Error('Finish or cancel uninstalling Kibu before starting a task.')
  // A missing Anthropic key is no longer fatal: the Jev-only workflows can
  // still run, Claude Code can stand in for the planner, and the runtime
  // reports clearly if a request needs something that is not configured.
  if (settings.useClaudeCode && !codingAppAvailable(settings.codingApp)) throw new Error('Your selected coding app is no longer installed. Choose an installed app in Settings.')
  const planViaClaudeCode = settings.useClaudeCode
  if (measuring) throw new Error('Wait for the measurement to finish before starting a task.')
  if (currentTask && !isTerminal(currentTask.status)) throw new Error('A task is already running.')

  const task = newTask(req)
  const previous = previousTurn(req.followUp)
  if (req.followUp && previous) {
    task.replyTo = req.followUp
    task.conversationId = store.getTask(req.followUp)?.conversationId ?? req.followUp
  }
  ;(task as TaskState & { droppedPaths?: string[] }).droppedPaths = (req.droppedPaths ?? []).map(normalizePath)
  currentTask = task
  store.saveTask(task)
  setPetState('thinking')

  let sent = false
  try {
    await runtime.ensureReady()
    if (isTerminal(task.status)) { restRuntime(); return task }
    sent = runtime.send({
      type: 'start',
      task,
      apiKey: secrets.getApiKey(),
      jevApiKey: secrets.getJevKey(),
      model: { ...DEFAULT_MODEL_CONFIG, claudeCode: settings.claudeCodeModel, codex: settings.codexModel, opencode: settings.opencodeModel },
      frontWindow: req.includeFrontWindow ? lastFrontWindow : null,
      previousApp: lastFrontWindow?.name ?? null,
      memories: settings.memoryEnabled ? store.listMemories() : [],
      memory: { enabled: settings.memoryEnabled, learn: settings.memoryEnabled && settings.memoryLearn },
      confirmEveryAction: settings.confirmEveryAction,
      workflowsEnabled: settings.workflowsFirst,
      useClaudeCode: planViaClaudeCode,
      codingApp: settings.codingApp,
      previousTurn: previous
    })
  } catch (err) {
    task.error = err instanceof Error ? err.message : String(err)
  }
  if (!sent) {
    task.status = 'failed'
    task.summary = { headline: task.error ?? 'The task runtime could not start. Try again.', evidence: [], undoable: false }
    store.saveTask(task)
    broadcast(IPC.onTaskUpdate, task)
    setPetState('failed')
    restRuntime()
  }
  return task
}

function onRuntimeMessage(msg: RuntimeToHost): void {
  switch (msg.type) {
    case 'task-update': {
      if (store.isDeleted(msg.task.id)) break
      currentTask = msg.task
      if (msg.task.summary && ['succeeded', 'failed'].includes(msg.task.status)) {
        lastFinished = { id: msg.task.id, request: msg.task.request, headline: msg.task.summary.headline, at: Date.now() }
      }
      const finishedNow = ['succeeded', 'failed'].includes(msg.task.status) && store.getTask(msg.task.id)?.status !== msg.task.status
      store.saveTask(msg.task)
      broadcast(IPC.onTaskUpdate, msg.task)
      if (isTerminal(msg.task.status)) restRuntime()
      // With no pet on the desktop, a result nobody is looking at arrives as a notification.
      if (finishedNow && settings.petMode === 'menubar' && !panelWindow?.isVisible() && Notification.isSupported() && msg.task.summary) {
        const done = new Notification({ title: msg.task.status === 'succeeded' ? 'Kibu is done' : 'Kibu couldn’t finish', body: plainHeadline(msg.task.summary.headline) })
        done.on('click', () => togglePanelShow())
        done.show()
      }
      // A task that is waiting on an answer must not wait invisibly: the panel
      // hides itself on blur, so bring it back when a question appears.
      if (msg.task.question && panelWindow && !panelWindow.isDestroyed() && !panelWindow.isVisible()) {
        togglePanelShow()
      }
      break
    }
    case 'tool-call': {
      try {
        if (msg.tool !== 'brain' || !currentTask || msg.taskId !== currentTask.id || isTerminal(currentTask.status)) throw new Error('This workspace request is not part of an active task.')
        const value = brain.request(msg.input)
        broadcast(IPC.onBrain, brain.snapshot())
        runtime.send({ type: 'tool-result', callId: msg.callId, ok: true, value })
        tickBrain()
      } catch (err) { runtime.send({ type: 'tool-result', callId: msg.callId, ok: false, error: err instanceof Error ? err.message : String(err) }) }
      break
    }
    case 'pet-state':
      setPetState(msg.state)
      break
    case 'memory': {
      const e = msg.event
      if (e.type === 'save') store.saveMemory(e.memory, e.replaces)
      else if (e.type === 'forget') store.deleteMemories(e.ids)
      else store.markMemoriesUsed(e.ids)
      broadcast(IPC.onMemories, store.listMemories())
      break
    }
    case 'log': {
      if (store.isDeleted(msg.entry.taskId)) break
      store.appendLog(msg.entry)
      broadcast(IPC.onLog, msg.entry)
      break
    }
    case 'desktop-claim':
      try {
        desktopSession.claim(msg.taskId, msg.reason)
      } catch (err) {
        store.appendLog({
          taskId: msg.taskId,
          at: Date.now(),
          level: 'warn',
          source: 'desktop',
          message: err instanceof Error ? err.message : String(err)
        })
      }
      break
    case 'desktop-release':
      desktopSession.release(msg.taskId)
      break
    case 'error': {
      const entry: LogEntry = {
        taskId: currentTask?.id ?? 'runtime',
        at: Date.now(),
        level: 'error',
        source: 'runtime',
        message: msg.message
      }
      store.appendLog(entry)
      broadcast(IPC.onLog, entry)
      // A fatal runtime error exits the child. The exit handler records the
      // interrupted task; the next request starts a fresh child on demand.
      break
    }
  }
}

/* ------------------------------------------------------------------ *
 * Windows and shortcut
 * ------------------------------------------------------------------ */

/**
 * When the panel gained and lost focus. A click on the pet activates Kibu,
 * and macOS hands focus back to the panel during that same click, so asking
 * "is the panel focused?" when the click arrives always says yes. Asking what
 * it was just before the button went down gives the real answer.
 */
const panelFocusLog: { at: number; focused: boolean }[] = []

function notePanelFocus(focused: boolean): void {
  panelFocusLog.push({ at: Date.now(), focused })
  if (panelFocusLog.length > 40) panelFocusLog.shift()
}

function panelFocusedAt(time: number): boolean {
  for (let i = panelFocusLog.length - 1; i >= 0; i--) if (panelFocusLog[i]!.at <= time) return panelFocusLog[i]!.focused
  return false
}

function togglePanel(focusInput = true, pressedAt?: number): void {
  if (!panelWindow || panelWindow.isDestroyed()) return
  // Whatever you were in before this click is "the previous app", whether the
  // panel was hidden or just behind it.
  if (!panelWindow.isVisible() || !(pressedAt ? panelFocusedAt(pressedAt - 20) : panelWindow.isFocused())) void captureFrontWindow()
  if (panelWindow.isVisible()) {
    // Docked, the panel is a handle on the edge of the screen: the shortcut
    // should open it out, not put it away.
    if (isPanelDocked()) {
      showPanel()
      if (focusInput) panelWindow.webContents.send(IPC.onFocusInput)
      return
    }
    // Open but behind whatever you were working in is not "open" to you. A
    // click on the pet then means "show me", and hiding the panel instead
    // looked like the click had done nothing. It only puts the panel away
    // when you are actually using it.
    //
    // For a pet click, "using it" means focused just before the button went
    // down; see panelFocusLog.
    const inUse = pressedAt ? panelFocusedAt(pressedAt - 20) : panelWindow.isFocused()
    if (!inUse) {
      showPanel()
      if (focusInput) panelWindow.webContents.send(IPC.onFocusInput)
      return
    }
    hidePanel()
    if (!currentTask || ['succeeded', 'failed', 'cancelled'].includes(currentTask.status)) {
      setPetState('idle')
    }
    return
  }
  showPanel()
  if (focusInput) panelWindow.webContents.send(IPC.onFocusInput)
  // The pet looks up when the panel is open and nothing is running.
  if (!currentTask || ['succeeded', 'failed', 'cancelled'].includes(currentTask.status)) {
    setPetState('listening')
  }
}

/** Shows the panel without toggling it closed if it is already open. */
function togglePanelShow(): void {
  if (!panelWindow || panelWindow.isDestroyed()) return
  if (!panelWindow.isVisible()) void captureFrontWindow()
  showPanel()
}

/**
 * Brings the panel forward, open and where the user left it.
 *
 * A panel that re-centres itself every time it appears cannot be put
 * anywhere, so the pet only decides the placement until the user first drags
 * the window; after that the saved position is the only thing consulted.
 */
function showPanel(): void {
  if (!panelWindow || panelWindow.isDestroyed()) return
  if (isPanelDocked()) {
    // Opening from the tray or the shortcut means the user wants the panel,
    // not the handle they tucked away.
    togglePanelDock(panelWindow)
    broadcastPanelState()
  } else if (settings.panelX < 0 || settings.panelY < 0) {
    if (petWindow) positionPanelNearPet(panelWindow, petWindow)
  } else if (!panelWindow.isVisible()) {
    placeOnActiveDisplay(panelWindow, { x: settings.panelX, y: settings.panelY })
  }
  // Kibu is a menu-bar accessory, so it is almost never the active app when
  // you click the pet or press the shortcut. Take focus explicitly, or the
  // panel can open behind the app you were in with the keyboard still there.
  if (process.platform === 'darwin') app.focus({ steal: true })
  if (panelWindow.isVisible()) panelWindow.show()
  else fadeIn(panelWindow)
  panelWindow.moveTop()
  panelWindow.focus()
  petPresence.setPanelOpen(true)
  petPresence.reveal()
  if (!currentTask || isTerminal(currentTask.status)) setPetState('listening')
  if (runtimeIdleTimer) { clearTimeout(runtimeIdleTimer); runtimeIdleTimer = null }
}

/** Forgets where the panel was dragged and puts it back in the default spot. */
function recenterPanel(): void {
  if (!panelWindow || panelWindow.isDestroyed()) return
  if (isPanelDocked()) { togglePanelDock(panelWindow); broadcastPanelState() }
  if (!panelWindow.isVisible()) showPanel()
  centerPanel(panelWindow)
  saveSettings({ panelX: -1, panelY: -1 })
}

/** Set while a native dialog owned by the panel is open. */
let panelDialogOpen = false
let blurTimer: NodeJS.Timeout | null = null

/**
 * Clicking somewhere else puts the panel away, the way Spotlight does.
 *
 * Left open behind other apps, the panel was covered on the first click
 * elsewhere and then turned up again on the next window or Space switch,
 * which read as a window popping up on its own. Now it goes, and comes back
 * only when asked for. "Keep in front" means stay, so a pinned panel is left
 * alone; and a running task shrinks to the island instead, so its progress
 * stays in view without the panel in the way.
 */
function putAwayAfterBlur(): void {
  blurTimer = null
  if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible()) return
  if (panelWindow.isFocused() || isPanelPinned() || isPanelDocked() || isPanelAnimating() || panelDialogOpen || quitting) return
  if (currentTask && !isTerminal(currentTask.status)) {
    togglePanelDock(panelWindow)
    broadcastPanelState()
    return
  }
  hidePanel()
  setPetState('idle')
}

/** Puts the panel away. A hidden panel is never a docked one. */
function hidePanel(): void {
  if (!panelWindow || panelWindow.isDestroyed()) return
  panelWindow.hide()
  petPresence.setPanelOpen(false)
  restRuntime()
  resetPanelDock(panelWindow)
  broadcastPanelState()
}

function broadcastPanelState(): void {
  broadcast(IPC.onPanelState, { docked: isPanelDocked(), pinned: isPanelPinned() })
}

/**
 * Kibu opens with one chord, from anywhere. ⌘⇧Space avoids ChatGPT's
 * ⌥Space pet shortcut. If another app already holds the
 * chosen key, the next free one is used and saved, so the key shown in the
 * menu and in setup is always the one that works.
 */
const SHORTCUT_FALLBACKS = ['Command+Shift+Space', 'Alt+Shift+Space', 'CommandOrControl+Shift+K']

function registerShortcut(accelerator: string): boolean {
  globalShortcut.unregisterAll()
  for (const key of [accelerator, ...SHORTCUT_FALLBACKS.filter((k) => k !== accelerator)]) {
    try {
      if (globalShortcut.register(key, () => togglePanel(true))) {
        if (key !== accelerator) {
          console.warn(`The shortcut ${accelerator} is taken by another app; using ${key} instead.`)
          saveSettings({ shortcut: key })
        }
        return key === accelerator
      }
    } catch { /* an accelerator Electron cannot parse: try the next */ }
  }
  return false
}

/** Puts the pet somewhere visible, for when it has been dragged off-screen. */
function recentrePet(): void {
  if (!petWindow || petWindow.isDestroyed()) return
  const display = screen.getPrimaryDisplay().workArea
  petWindow.setPosition(display.x + display.width - 200, display.y + display.height - 230, false)
  if (settings.petMode !== 'menubar') petWindow.showInactive()
  const [x = -1, y = -1] = petWindow.getPosition()
  saveSettings({ petX: x, petY: y })
}

function createTray(): void {
  // A template image: macOS recolours it for light and dark menu bars.
  const iconPath = resourcePath('resources', 'trayTemplate.png')
  const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('Kibu: click to open, right-click for more')
  // One click opens Kibu. A context menu set with setContextMenu would take
  // the left click on macOS, so it is popped up on right-click instead.
  const menu = (): Electron.Menu =>
    Menu.buildFromTemplate([
      { label: 'Open Kibu', accelerator: settings.shortcut, click: () => togglePanel(true) },
      { label: 'Workspace & timers', click: openBrain },
      { label: 'Show the pet', click: () => { recentrePet(); petPresence.showFor(5000) } },
      { label: 'Hide Kibu', click: () => petPresence.hide() },
      { label: 'Center the panel', click: () => recenterPanel() },
      { type: 'separator' },
      {
        label: 'Stop current task',
        click: () => {
          if (currentTask) runtime.send({ type: 'cancel', taskId: currentTask.id })
        }
      },
      { type: 'separator' },
      { label: 'Uninstall Kibu…', click: () => { showPanel(); void uninstaller.uninstall().catch((err: unknown) => { void dialog.showMessageBox(panelWindow!, { type: 'error', message: 'Couldn’t uninstall Kibu', detail: err instanceof Error ? err.message : String(err) }) }) } },
      { label: 'Quit Kibu', click: () => app.quit() }
    ])
  tray.on('click', () => togglePanel(true))
  tray.on('right-click', () => tray?.popUpContextMenu(menu()))
}

/* ------------------------------------------------------------------ *
 * IPC: the only path from the unprivileged renderer into privileged code.
 * Every handler validates its own input.
 * ------------------------------------------------------------------ */

/**
 * Remembers what the user was looking at, so "help me with this window" means
 * their window rather than Kibu's own panel. Failures are silent: this is a
 * convenience, and Accessibility permission may simply not be granted.
 */
async function captureFrontWindow(): Promise<void> {
  if (!osAdapter?.supports('window.inspect')) return
  try {
    const apps = await osAdapter.listApps()
    const front = apps.find((a) => a.active && a.pid !== process.pid)
    if (!front) return
    const snapshot = await osAdapter.inspectWindow(front.pid, { maxNodes: 1 }).catch(() => null)
    lastFrontWindow = { pid: front.pid, name: front.name, title: snapshot?.title ?? '' }
  } catch {
    lastFrontWindow = null
  }
}

function openBrain(): void {
  togglePanelShow()
  panelWindow?.webContents.send(IPC.onBrainOpen)
}

function tickBrain(): void {
  if (quitting || brainSleeping || brainLocked) return
  try {
    if (powerMonitor.getSystemIdleState(1) === 'locked' || !brain.hasDue()) return
    const { state, alerts } = brain.tick()
    if (!alerts.length) return
    broadcast(IPC.onBrain, state)
    if (Notification.isSupported()) {
      const first = alerts[0]!
      const notification = new Notification({ title: first.timer ? 'Time’s up' : 'Kibu reminder', body: alerts.length === 1 ? first.title : `${first.title} + ${alerts.length - 1} more`, silent: false })
      notification.on('click', openBrain)
      notification.show()
    }
  } catch (err) { console.error('[brain]', err) }
}

function registerIpc(): void {
  ipcMain.handle(IPC.appUninstallStatus, () => uninstaller.available)
  ipcMain.handle(IPC.appUninstall, () => uninstaller.uninstall())
  ipcMain.handle(IPC.brainGet, () => brain.snapshot())
  ipcMain.handle(IPC.brainOpen, openBrain)
  ipcMain.handle(IPC.brainRequest, (_e, req: unknown) => {
    const result = brain.request(req)
    broadcast(IPC.onBrain, brain.snapshot())
    tickBrain()
    return result
  })
  ipcMain.handle(IPC.taskStart, (_e, req: StartTaskRequest) => {
    if (typeof req?.request !== 'string' || !req.request.trim()) {
      throw new Error('a request is required')
    }
    const droppedPaths = Array.isArray(req.droppedPaths)
      ? req.droppedPaths.filter((p): p is string => typeof p === 'string').slice(0, 200)
      : []
    const followUp = typeof req.followUp === 'string' ? req.followUp : req.followUp === null ? null : undefined
    return startTask({ request: req.request.slice(0, 4000), droppedPaths, includeFrontWindow: !!req.includeFrontWindow, followUp })
  })

  ipcMain.handle(IPC.taskPause, (_e, taskId: string) => {
    runtime.send({ type: 'pause', taskId })
  })
  ipcMain.handle(IPC.taskResume, (_e, taskId: string) => {
    runtime.send({ type: 'resume', taskId })
  })
  ipcMain.handle(IPC.taskCancel, (_e, taskId: string) => {
    if (currentTask?.id === taskId && !runtime.isReady && !isTerminal(currentTask.status)) {
      currentTask.status = 'cancelled'
      currentTask.statusLine = 'Cancelled'
      store.saveTask(currentTask)
      broadcast(IPC.onTaskUpdate, currentTask)
      setPetState('idle')
      restRuntime()
      return
    }
    runtime.send({ type: 'cancel', taskId })
  })

  ipcMain.handle(IPC.taskAnswer, (_e, req: AnswerQuestionRequest) => {
    if (!req?.taskId || !req.questionId) throw new Error('taskId and questionId are required')
    runtime.send({
      type: 'answer',
      taskId: req.taskId,
      answer: {
        questionId: req.questionId,
        optionId: req.optionId ?? null,
        text: typeof req.text === 'string' ? req.text.slice(0, 4000) : undefined,
        grant: req.grant
      }
    })
  })

  ipcMain.handle(IPC.taskUndo, async (_e, taskId: string) => {
    if (typeof taskId !== 'string') throw new Error('taskId is required')
    return undoTask(store, taskId)
  })

  ipcMain.handle(IPC.taskGet, (_e, taskId: string) => store.getTask(taskId))
  ipcMain.handle(IPC.historyList, (_e, limit?: number) => store.listTasks(Math.min(limit ?? 25, 100)))
  const forget = (ids: string[]): void => {
    if (lastFinished && ids.includes(lastFinished.id)) lastFinished = null
    if (currentTask && ids.includes(currentTask.id)) { currentTask = null; setPetState('idle') }
    broadcast(IPC.onHistoryDeleted, ids)
  }
  ipcMain.handle(IPC.historyDelete, (_e, id: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('A task ID is required.')
    if (currentTask?.id === id && !isTerminal(currentTask.status)) throw new Error('Stop this task before deleting it.')
    // A History row is a chat, so deleting it deletes every turn of it.
    forget(store.deleteConversation(id))
  })
  ipcMain.handle(IPC.historyClear, () => { forget(store.clearHistory()) })
  ipcMain.handle(IPC.choosePaths, async () => {
    // The picker takes focus from the panel; that is not the user leaving.
    panelDialogOpen = true
    try {
      const result = await dialog.showOpenDialog(panelWindow!, { properties: ['openFile', 'openDirectory', 'multiSelections'], buttonLabel: 'Attach' })
      return result.canceled ? [] : result.filePaths
    } finally {
      panelDialogOpen = false
      panelWindow?.focus()
    }
  })



  ipcMain.handle(IPC.permissionsGet, () => osAdapter.getPermissions())
  ipcMain.handle(IPC.permissionsRequest, (_e, p: string) => {
    const allowed = ['accessibility', 'screen-recording', 'automation', 'full-disk']
    if (!allowed.includes(p)) throw new Error(`unknown permission: ${p}`)
    return osAdapter.requestPermission(p as 'accessibility')
  })

  ipcMain.handle(IPC.setupGet, () => setup.list())
  ipcMain.handle(IPC.setupRequest, async (_e, id: unknown) => {
    if (!isSetupId(id)) throw new Error('Unknown permission.')
    // A system dialog takes focus from the panel; that is not the person leaving.
    panelDialogOpen = true
    try { return await setup.request(id) } finally { panelDialogOpen = false }
  })
  ipcMain.handle(IPC.setupOpenSettings, (_e, id: unknown) => {
    if (!isSetupId(id)) throw new Error('Unknown permission.')
    return setup.openSettings(id)
  })

  ipcMain.handle(IPC.secretsSet, (_e, key: string) => {
    if (typeof key !== 'string') throw new Error('key must be a string')
    return secrets.setApiKey(key)
  })
  ipcMain.handle(IPC.secretsStatus, () => secrets.hasApiKey())

  ipcMain.handle(IPC.secretsSetJev, (_e, key: string) => {
    if (typeof key !== 'string') throw new Error('key must be a string')
    return secrets.setJevKey(key)
  })
  ipcMain.handle(IPC.secretsStatusJev, () => secrets.hasJevKey())
  ipcMain.handle(IPC.claudeCodeStatus, () => claudeCodeAvailable())
  ipcMain.handle(IPC.codingAppsStatus, () => codingAppStatus())
  ipcMain.handle(IPC.codingModels, (_e, codingApp: CodingApp, refresh?: boolean) => {
    if (!['claude-code', 'codex', 'opencode'].includes(codingApp)) throw new Error('Unknown coding app.')
    return codingModels(codingApp, refresh === true)
  })
  const checkingModels = new Set<CodingApp>()
  ipcMain.handle(IPC.codingModelCheck, async (_e, codingApp: CodingApp, model: string) => {
    if (!['claude-code', 'codex', 'opencode'].includes(codingApp)) throw new Error('Unknown coding app.')
    if (typeof model !== 'string' || !model.trim() || !validCodingModel(model.trim())) throw new Error('Invalid model ID.')
    if (checkingModels.has(codingApp)) return { ok: false, message: 'An access check is already running for this app. Wait a moment and retry.' }
    checkingModels.add(codingApp)
    try { return await checkCodingModel(codingApp, model.trim()) }
    finally { checkingModels.delete(codingApp) }
  })
  // The same condition startTask enforces, so the interface can never nag for
  // a key that is not actually needed.
  ipcMain.handle(IPC.canWork, () => canWork())

  // One measurement pass, answered by the runtime because that is where the
  // Jev client and its key live. Nothing here ever sees the key itself.
  ipcMain.handle(IPC.benchRun, async () => {
    if (measuring || (currentTask && !isTerminal(currentTask.status))) throw new Error('Finish the current work before measuring.')
    measuring = true
    try {
      await runtime.ensureReady()
      const rows = await new Promise<BenchRow[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          runtime.off('message', onMessage)
          reject(new Error('the measurement did not finish in time'))
        }, 60_000)
        const onMessage = (msg: RuntimeToHost): void => {
          if (msg.type !== 'bench-result') return
          clearTimeout(timer)
          runtime.off('message', onMessage)
          resolve(msg.rows)
        }
        runtime.on('message', onMessage)
        if (!runtime.send({ type: 'bench', jevApiKey: secrets.getJevKey(), model: DEFAULT_MODEL_CONFIG })) {
          clearTimeout(timer)
          runtime.off('message', onMessage)
          reject(new Error('the task runtime is not running'))
        }
      })
      return rows
    } finally { measuring = false; restRuntime() }
  })

  ipcMain.handle(IPC.settingsGet, () => settings)
  ipcMain.handle(IPC.settingsSet, (_e, next: Partial<Settings>) => {
    if (next.launchAtLogin !== undefined) {
      if (typeof next.launchAtLogin !== 'boolean') throw new Error('Invalid login preference.')
      if (!app.isPackaged) throw new Error('Open at login is available in an installed Kibu build. During development, keep Kibu running for reminders.')
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
    }
    if (next.onboarded !== undefined && typeof next.onboarded !== 'boolean') throw new Error('Invalid setup state.')
    if (next.petMode !== undefined && !['ondemand', 'peek', 'menubar', 'desktop'].includes(next.petMode)) throw new Error('Unknown place for the pet.')
    if (next.petMode !== undefined) next.petModeChosen = true
    if (next.codingApp !== undefined && !['claude-code', 'codex', 'opencode'].includes(next.codingApp)) throw new Error('Unknown coding app.')
    // A model name ends up as a command-line argument: it may only look like one.
    for (const key of ['claudeCodeModel', 'codexModel', 'opencodeModel'] as const) {
      const value = next[key]
      if (value !== undefined && (typeof value !== 'string' || !validCodingModel(value.trim()))) throw new Error('That does not look like a model name.')
      if (key === 'claudeCodeModel' && typeof value === 'string' && !value.trim()) throw new Error('Choose a Claude Code model.')
      if (typeof value === 'string') next[key] = value.trim()
    }
    if (next.shortcut !== undefined && (typeof next.shortcut !== 'string' || !/^[A-Za-z0-9+]{1,60}$/.test(next.shortcut))) throw new Error('That is not a shortcut.')
    if (next.shortcut !== undefined && /^(Command|CommandOrControl|CmdOrCtrl|Cmd)\+Space$/.test(next.shortcut)) throw new Error('⌘ Command + Space opens Spotlight. Pick another. ⌘ Command + ⇧ Shift + Space is the default.')
    const before = settings.shortcut
    if (next.shortcut !== undefined) next.shortcutChosen = true
    const updated = saveSettings(next ?? {})
    // A key another app holds falls back to a free one, which is saved: report that one.
    if (updated.shortcut !== before) registerShortcut(updated.shortcut)
    if (next.petMode !== undefined) {
      broadcast(IPC.onBrain, brain.snapshot())
      petPresence.update()
      tray?.setTitle('')
    }
    return settings
  })

  // Path-taking shell operations are constrained: documents and folders open,
  // but anything that would run (an app, a script, an installer) is only
  // revealed in Finder, so a result link can never launch code.
  ipcMain.handle(IPC.revealPath, (_e, p: string) => {
    const path = normalizePath(String(p))
    if (!existsSync(path)) throw new Error('that path no longer exists')
    shell.showItemInFolder(path)
  })
  ipcMain.handle(IPC.openPath, async (_e, p: string) => {
    const path = normalizePath(String(p))
    if (!existsSync(path)) throw new Error('that path no longer exists')
    if (wouldLaunch(path)) {
      shell.showItemInFolder(path)
      return
    }
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })

  ipcMain.handle(IPC.openUrl, async (_e, url: unknown) => {
    await shell.openExternal(externalWebUrl(url))
  })

  ipcMain.handle(IPC.panelResize, (_e, height: number) => {
    if (!panelWindow || panelWindow.isDestroyed()) return
    resizePanel(panelWindow, height)
  })
  ipcMain.handle(IPC.panelClose, () => hidePanel())
  ipcMain.handle(IPC.panelCenter, () => recenterPanel())

  // The panel is moved by grabbing any empty part of it. CSS drag regions
  // proved unreliable on a transparent frameless window, so the move is done
  // here: remember where the window and cursor were when the grab began, and
  // follow the real cursor from then on.
  let grab: { cx: number; cy: number; x: number; y: number } | null = null
  ipcMain.handle(IPC.panelDrag, (_e, phase: unknown) => {
    if (!panelWindow || panelWindow.isDestroyed() || isPanelDocked()) return
    const cursor = screen.getCursorScreenPoint()
    if (phase === 'start') {
      const [x = 0, y = 0] = panelWindow.getPosition()
      grab = { cx: cursor.x, cy: cursor.y, x, y }
      return
    }
    if (!grab) return
    if (phase === 'move') {
      panelWindow.setPosition(grab.x + cursor.x - grab.cx, grab.y + cursor.y - grab.cy, false)
      return
    }
    if (phase === 'end') {
      grab = null
      const [x = -1, y = -1] = panelWindow.getPosition()
      saveSettings({ panelX: x, panelY: y })
    }
  })
  ipcMain.handle(IPC.panelMinimize, () => {
    if (!panelWindow || panelWindow.isDestroyed()) return
    togglePanelDock(panelWindow)
    broadcastPanelState()
    // Coming back from the edge means "I want to type": hand over focus.
    if (!isPanelDocked()) {
      if (process.platform === 'darwin') app.focus({ steal: true })
      panelWindow.focus()
      panelWindow.webContents.send(IPC.onFocusInput)
    }
  })
  ipcMain.handle(IPC.panelPin, (_e, value: unknown) => {
    if (!panelWindow || panelWindow.isDestroyed()) return
    setPanelPinned(panelWindow, !!value)
    saveSettings({ panelPinned: !!value })
    broadcastPanelState()
  })
  ipcMain.handle(IPC.panelStateGet, () => ({ docked: isPanelDocked(), pinned: isPanelPinned() }))
  ipcMain.handle(IPC.petClicked, (_e, pressedAt: unknown) => {
    const at = typeof pressedAt === 'number' && Number.isFinite(pressedAt) && Math.abs(Date.now() - pressedAt) < 5000 ? pressedAt : undefined
    togglePanel(true, at) })
  // A bubble suggestion: open the panel with the words typed in, never sent.
  ipcMain.handle(IPC.petCompose, (_e, text: unknown) => {
    if (typeof text !== 'string' || !panelWindow || panelWindow.isDestroyed()) return
    togglePanelShow()
    // Empty means "just open": never wipe a half-typed draft.
    if (text) panelWindow.webContents.send(IPC.onSeed, text.slice(0, 500))
    panelWindow.webContents.send(IPC.onFocusInput)
  })
  ipcMain.handle(IPC.petInteractive, (_e, v: unknown) => setPetInteractive(petWindow, !!v))
  // The pet's own menu: open Kibu, or play with it the way the website does.
  ipcMain.handle(IPC.petMenu, (_e, napping: unknown) => {
    if (!petWindow || petWindow.isDestroyed()) return
    const play = (action: PetPlay) => () => petWindow?.webContents.send(IPC.onPetPlay, action)
    Menu.buildFromTemplate([
      { label: 'Open Kibu', click: () => togglePanelShow() },
      { label: 'Hide Kibu', click: () => petPresence.hide() },
      { type: 'separator' },
      { label: 'Dance break', click: play('dance') },
      napping ? { label: 'Wake up', click: play('wake') } : { label: 'Little nap', click: play('nap') },
      { label: 'Surprise me', click: play('surprise') }
    ]).popup({ window: petWindow })
  })
  ipcMain.handle(IPC.memoriesList, () => store.listMemories())
  ipcMain.handle(IPC.memoryDelete, (_e, id: unknown) => {
    if (typeof id === 'string') store.deleteMemories([id])
    const all = store.listMemories()
    broadcast(IPC.onMemories, all)
    return all
  })
  ipcMain.handle(IPC.memoriesClear, () => {
    store.clearMemories()
    broadcast(IPC.onMemories, [])
    return []
  })
  ipcMain.handle(IPC.petHitRects, (_e, rects: unknown) => {
    if (Array.isArray(rects)) setPetHitRects(rects as { x: number; y: number; width: number; height: number }[])
  })

  ipcMain.handle(IPC.petDrag, (_e, delta: { dx: number; dy: number }) => {
    if (!petWindow || petWindow.isDestroyed()) return
    const dx = Number(delta?.dx)
    const dy = Number(delta?.dy)
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    const [x = 0, y = 0] = petWindow.getPosition()
    petWindow.setPosition(Math.round(x + dx), Math.round(y + dy), false)
  })

  ipcMain.handle(IPC.petDropped, (_e, paths: unknown) => {
    const list = Array.isArray(paths)
      ? paths.filter((p): p is string => typeof p === 'string').slice(0, 200)
      : []
    if (!list.length) return
    togglePanelShow()
    broadcast(IPC.onDroppedPaths, list)
  })

  ipcMain.handle(IPC.frontWindowGet, () => lastFrontWindow)

  ipcMain.handle(IPC.desktopStop, () => {
    if (currentTask) runtime.send({ type: 'cancel', taskId: currentTask.id })
  })
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => togglePanel(true))

  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'))
    brain = new BrainStore(app.getPath('userData'))
    secrets = new Secrets(store)
    settings = loadSettings()
    // Persist migrations so an older preference cannot reappear after an update.
    saveSettings({})
    uninstaller = new AppUninstaller({
      executable: () => app.getPath('exe'),
      packaged: () => app.isPackaged && process.platform === 'darwin',
      confirm: async () => {
        if (!panelWindow || panelWindow.isDestroyed()) return false
        panelDialogOpen = true
        try {
          const result = await dialog.showMessageBox(panelWindow, {
            type: 'question', title: 'Uninstall Kibu',
            message: 'Move Kibu to Trash?',
            detail: 'Kibu will stop, including running tasks, timers and reminders, and will no longer open at login. Your saved history and settings stay on this Mac.',
            buttons: ['Cancel', 'Move to Trash'], defaultId: 0, cancelId: 0
          })
          return result.response === 1
        } finally { panelDialogOpen = false }
      },
      loginEnabled: () => app.getLoginItemSettings().openAtLogin,
      setLoginEnabled: (value) => { app.setLoginItemSettings({ openAtLogin: value }); saveSettings({ launchAtLogin: value }) },
      stopWork: async () => {
        await runtime.stop()
        if (currentTask && !isTerminal(currentTask.status)) {
          currentTask.status = 'cancelled'
          currentTask.statusLine = 'Stopped for uninstall'
          currentTask.summary = { headline: 'Stopped for uninstall', evidence: [], undoable: store.undoableActions(currentTask.id).length > 0 }
          store.saveTask(currentTask)
          broadcast(IPC.onTaskUpdate, currentTask)
          desktopSession.release(currentTask.id)
          setPetState('idle')
        }
      },
      trash: (bundle) => shell.trashItem(bundle),
      quit: () => app.quit()
    })

    const interrupted = store.recoverInterruptedTasks()
    if (interrupted.length) {
      store.appendLog({
        taskId: interrupted[0]!,
        at: Date.now(),
        level: 'warn',
        source: 'recovery',
        message: `${interrupted.length} task(s) were interrupted by a quit or crash and were not resumed automatically.`
      })
    }

    startUpdateChecks((message) => console.log('[updates]', message))

    const p = paths()
    osAdapter = createOsAdapter(p.helper)
    setup = new Setup(osAdapter, store)
    desktopSession = new DesktopSession()
    desktopSession.on('changed', (active: boolean) => broadcast(IPC.onDesktopSession, active))
    desktopSession.on('stop-requested', (taskId: string | null) => {
      if (taskId) runtime.send({ type: 'cancel', taskId })
    })

    runtime = new RuntimeHost({
      entry: p.runtimeEntry,
      helperPath: p.helper,
      browserProfileDir: p.browserProfile,
      downloadDir: p.downloads,
      jevEnabled: settings.jevEnabled
    })
    runtime.on('message', onRuntimeMessage)
    runtime.on('stderr', (text: string) => console.error('[runtime]', text.trim()))
    runtime.on('spawn-error', (err: Error) => {
      // Without a runtime Kibu cannot do anything, so this must be loud.
      const message = `The task runtime could not be started: ${err.message}`
      console.error('[runtime]', message)
      store.appendLog({
        taskId: currentTask?.id ?? 'runtime',
        at: Date.now(),
        level: 'error',
        source: 'runtime',
        message
      })
    })

    runtime.on('exit', ({ code, signal, expected }: { code: number | null; signal: string | null; expected: boolean }) => {
      // Idle shutdown is expected. Every other exit, even with code zero,
      // interrupts any active task and must be reported.
      if (quitting || expected) return
      const message = `The task runtime exited unexpectedly (code ${code}, signal ${signal}). It will restart when needed.`
      console.error('[runtime]', message)
      store.appendLog({
        taskId: currentTask?.id ?? 'runtime',
        at: Date.now(),
        level: 'error',
        source: 'runtime',
        message
      })
      // If a task was in flight, it died with the runtime. Say so rather than
      // leaving the pet spinning on a task that no longer exists.
      if (currentTask && !['succeeded', 'failed', 'cancelled'].includes(currentTask.status)) {
        currentTask.status = 'failed'
        currentTask.statusLine = 'The runtime stopped'
        currentTask.error = 'The task runtime stopped unexpectedly. Nothing was resumed automatically.'
        currentTask.summary = {
          headline: 'Stopped: the task runtime crashed',
          evidence: currentTask.summary?.evidence ?? [],
          undoable: store.undoableActions(currentTask.id).length > 0
        }
        store.saveTask(currentTask)
        broadcast(IPC.onTaskUpdate, currentTask)
        setPetState('failed')
      }
    })

    registerIpc()

    petWindow = createPetWindow(
      { preload: p.preload, rendererUrl: RENDERER_URL, rendererFile: p.rendererFile },
      { x: settings.petX, y: settings.petY },
      settings.petMode === 'desktop'
    )
    petWindow.on('moved', () => {
      const [x = -1, y = -1] = petWindow!.getPosition()
      saveSettings({ petX: x, petY: y })
    })
    followCursor()

    panelWindow = createPanelWindow(
      { preload: p.preload, rendererUrl: RENDERER_URL, rendererFile: p.rendererFile },
      { x: settings.panelX, y: settings.panelY, pinned: settings.panelPinned }
    )
    panelWindow.on('focus', () => notePanelFocus(true))
    panelWindow.on('blur', () => {
      notePanelFocus(false)
      if (blurTimer) clearTimeout(blurTimer)
      // A short grace: focus can flicker away and straight back during a
      // click on the pet or while macOS hands activation around.
      blurTimer = setTimeout(putAwayAfterBlur, 150)
    })
    panelWindow.on('show', () => petPresence.setPanelOpen(true))
    panelWindow.on('hide', () => { notePanelFocus(false); petPresence.setPanelOpen(false); restRuntime() })
    panelWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); hidePanel() } })
    panelWindow.on('moved', () => {
      // Only a panel the user dragged is worth remembering; the docked handle
      // and the open/close animations place themselves.
      if (!panelWindow || isPanelDocked() || isPanelAnimating() || !panelWindow.isVisible()) return
      const [x = -1, y = -1] = panelWindow.getPosition()
      saveSettings({ panelX: x, panelY: y })
    })

    // First run: open straight onto setup rather than waiting to be found.
    if (!settings.onboarded) panelWindow.webContents.once('did-finish-load', () => setTimeout(togglePanelShow, 600))

    brainClock = setInterval(tickBrain, 1000)
    powerMonitor.on('suspend', () => { brainSleeping = true })
    powerMonitor.on('resume', () => { brainSleeping = false; tickBrain() })
    powerMonitor.on('lock-screen', () => { brainLocked = true })
    powerMonitor.on('unlock-screen', () => { brainLocked = false; tickBrain() })
    petWindow.webContents.on('did-finish-load', () => {
      tickBrain()
      broadcast(IPC.onBrain, brain.snapshot())
    })
    createTray()
    if (!registerShortcut(settings.shortcut)) {
      console.warn(`Could not register the global shortcut ${settings.shortcut}; it may be taken.`)
    }

    // Reopening the app means "show me", never "put it away".
    app.on('activate', () => togglePanelShow())
  })

  // Kibu lives in the menu bar, so closing its windows must not quit it.
  // Providing this handler and doing nothing is what keeps the app alive.
  app.on('window-all-closed', () => {})

  // before-quit runs before Electron closes windows. Waiting until will-quit
  // left the panel's close handler cancelling every quit (and uninstall).
  app.on('before-quit', async (event) => {
    event.preventDefault()
    if (quitting) return
    quitting = true
    if (runtimeIdleTimer) clearTimeout(runtimeIdleTimer)
    globalShortcut.unregisterAll()
    desktopSession?.dispose()
    try {
      await runtime?.stop()
    } finally {
      if (brainClock) clearInterval(brainClock)
      try { brain?.close(); store?.close() }
      finally { app.exit(0) }
    }
  })
}

export { homedir }
