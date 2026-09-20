import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, Tray, Menu, nativeImage } from 'electron'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { Store } from './services/db.js'
import { Secrets } from './services/secrets.js'
import { RuntimeHost } from './services/runtime-host.js'
import { DesktopSession } from './services/desktop-session.js'
import { undoTask } from './services/undo.js'
import { createPetWindow } from './windows/pet.js'
import { createPanelWindow, positionPanelNearPet, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT } from './windows/panel.js'
import { createOsAdapter } from '../os/index.js'
import { IPC, DEFAULT_MODEL_CONFIG, DEFAULT_SETTINGS } from '../shared/protocol.js'
import type {
  AnswerQuestionRequest,
  FrontWindow,
  LogEntry,
  RuntimeToHost,
  Settings,
  StartTaskRequest
} from '../shared/protocol.js'
import { defaultLimits, emptyAuthorization, type PetState, type TaskState } from '../shared/types.js'
import { normalizePath } from '../runtime/authorization.js'

const isDev = !app.isPackaged
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL ?? null

let store: Store
let secrets: Secrets
let runtime: RuntimeHost
let desktopSession: DesktopSession
let petWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let tray: Tray | null = null
let currentTask: TaskState | null = null
let settings: Settings = { ...DEFAULT_SETTINGS }
let osAdapter: ReturnType<typeof createOsAdapter>
/** Set during shutdown so the runtime's exit is not reported as a crash. */
let quitting = false
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
  const raw = store.getSetting('settings')
  if (!raw) return { ...DEFAULT_SETTINGS }
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
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
  for (const win of [petWindow, panelWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function setPetState(state: PetState): void {
  broadcast(IPC.onPetState, state)
}

/* ------------------------------------------------------------------ *
 * Task lifecycle
 * ------------------------------------------------------------------ */

/**
 * Builds the initial authorization for a task.
 *
 * Dropping files onto the pet is itself an act of authorization: it names
 * exactly what the user means. Nothing else is granted up front — anything
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

function startTask(req: StartTaskRequest): TaskState {
  // A missing Anthropic key is no longer fatal: the Jev-only workflows can
  // still run, and the runtime reports clearly if a request needs the planner.
  if (!secrets.hasApiKey() && !secrets.hasJevKey()) {
    const task = newTask(req)
    task.status = 'failed'
    task.statusLine = 'No API key'
    task.summary = {
      headline: 'Add an Anthropic key, a TypeSafe (Jev) key, or both in Settings before running a task.',
      evidence: [],
      undoable: false
    }
    currentTask = task
    broadcast(IPC.onTaskUpdate, task)
    setPetState('failed')
    return task
  }

  const task = newTask(req)
  ;(task as TaskState & { droppedPaths?: string[] }).droppedPaths = (req.droppedPaths ?? []).map(normalizePath)
  currentTask = task
  store.saveTask(task)

  const sent = runtime.send({
    type: 'start',
    task,
    apiKey: secrets.getApiKey(),
    jevApiKey: secrets.getJevKey(),
    model: DEFAULT_MODEL_CONFIG,
    frontWindow: req.includeFrontWindow ? lastFrontWindow : null,
    confirmEveryAction: settings.confirmEveryAction,
    workflowsEnabled: settings.workflowsFirst
  })
  if (!sent) {
    task.status = 'failed'
    task.summary = { headline: 'The task runtime is not running. Try again in a moment.', evidence: [], undoable: false }
    broadcast(IPC.onTaskUpdate, task)
  }
  return task
}

function onRuntimeMessage(msg: RuntimeToHost): void {
  switch (msg.type) {
    case 'task-update': {
      currentTask = msg.task
      store.saveTask(msg.task)
      broadcast(IPC.onTaskUpdate, msg.task)
      // A task that is waiting on an answer must not wait invisibly: the panel
      // hides itself on blur, so bring it back when a question appears.
      if (msg.task.question && panelWindow && !panelWindow.isDestroyed() && !panelWindow.isVisible()) {
        togglePanelShow()
      }
      break
    }
    case 'pet-state':
      setPetState(msg.state)
      break
    case 'log': {
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
      if (msg.fatal) runtime.restart()
      break
    }
  }
}

/* ------------------------------------------------------------------ *
 * Windows and shortcut
 * ------------------------------------------------------------------ */

function togglePanel(focusInput = true): void {
  if (!panelWindow || panelWindow.isDestroyed()) return
  if (!panelWindow.isVisible()) void captureFrontWindow()
  if (panelWindow.isVisible()) {
    panelWindow.hide()
    if (!currentTask || ['succeeded', 'failed', 'cancelled'].includes(currentTask.status)) {
      setPetState('idle')
    }
    return
  }
  if (petWindow) positionPanelNearPet(panelWindow, petWindow)
  panelWindow.show()
  panelWindow.focus()
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
  if (petWindow) positionPanelNearPet(panelWindow, petWindow)
  panelWindow.show()
  panelWindow.focus()
}

function registerShortcut(accelerator: string): boolean {
  globalShortcut.unregisterAll()
  try {
    return globalShortcut.register(accelerator, () => togglePanel(true))
  } catch {
    return false
  }
}

/** Puts the pet somewhere visible, for when it has been dragged off-screen. */
function recentrePet(): void {
  if (!petWindow || petWindow.isDestroyed()) return
  const display = screen.getPrimaryDisplay().workArea
  petWindow.setPosition(display.x + display.width - 200, display.y + display.height - 230, false)
  petWindow.showInactive()
  const [x = -1, y = -1] = petWindow.getPosition()
  saveSettings({ petX: x, petY: y })
}

function createTray(): void {
  // A template image: macOS recolours it for light and dark menu bars.
  const iconPath = resourcePath('resources', 'trayTemplate.png')
  const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('Kibu — click to open, or press the shortcut')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Kibu', accelerator: settings.shortcut, click: () => togglePanel(true) },
      { label: 'Bring pet back into view', click: () => recentrePet() },
      { type: 'separator' },
      {
        label: 'Stop current task',
        click: () => {
          if (currentTask) runtime.send({ type: 'cancel', taskId: currentTask.id })
        }
      },
      { type: 'separator' },
      { label: 'Quit Kibu', click: () => app.quit() }
    ])
  )
  tray.on('click', () => togglePanel(true))
}

/* ------------------------------------------------------------------ *
 * IPC — the only path from the unprivileged renderer into privileged code.
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

function registerIpc(): void {
  ipcMain.handle(IPC.taskStart, (_e, req: StartTaskRequest) => {
    if (typeof req?.request !== 'string' || !req.request.trim()) {
      throw new Error('a request is required')
    }
    const droppedPaths = Array.isArray(req.droppedPaths)
      ? req.droppedPaths.filter((p): p is string => typeof p === 'string').slice(0, 200)
      : []
    return startTask({ request: req.request.slice(0, 4000), droppedPaths, includeFrontWindow: !!req.includeFrontWindow })
  })

  ipcMain.handle(IPC.taskPause, (_e, taskId: string) => {
    runtime.send({ type: 'pause', taskId })
  })
  ipcMain.handle(IPC.taskResume, (_e, taskId: string) => {
    runtime.send({ type: 'resume', taskId })
  })
  ipcMain.handle(IPC.taskCancel, (_e, taskId: string) => {
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

  ipcMain.handle(IPC.permissionsGet, () => osAdapter.getPermissions())
  ipcMain.handle(IPC.permissionsRequest, (_e, p: string) => {
    const allowed = ['accessibility', 'screen-recording', 'automation', 'full-disk']
    if (!allowed.includes(p)) throw new Error(`unknown permission: ${p}`)
    return osAdapter.requestPermission(p as 'accessibility')
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

  ipcMain.handle(IPC.settingsGet, () => settings)
  ipcMain.handle(IPC.settingsSet, (_e, next: Partial<Settings>) => {
    const before = settings.shortcut
    const updated = saveSettings(next ?? {})
    if (updated.shortcut !== before) registerShortcut(updated.shortcut)
    return updated
  })

  // Path-taking shell operations are constrained: reveal only, never execute.
  ipcMain.handle(IPC.revealPath, (_e, p: string) => {
    const path = normalizePath(String(p))
    if (!existsSync(path)) throw new Error('that path no longer exists')
    shell.showItemInFolder(path)
  })
  ipcMain.handle(IPC.openPath, async (_e, p: string) => {
    const path = normalizePath(String(p))
    if (!existsSync(path)) throw new Error('that path no longer exists')
    await shell.openPath(path)
  })

  ipcMain.handle(IPC.panelResize, (_e, height: number) => {
    if (!panelWindow || panelWindow.isDestroyed()) return
    const clamped = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, Math.round(height)))
    const bounds = panelWindow.getBounds()
    panelWindow.setBounds({ ...bounds, height: clamped }, false)
    if (petWindow) positionPanelNearPet(panelWindow, petWindow)
  })
  ipcMain.handle(IPC.panelClose, () => panelWindow?.hide())
  ipcMain.handle(IPC.petClicked, () => togglePanel(true))

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
    secrets = new Secrets(store)
    settings = loadSettings()

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

    const p = paths()
    osAdapter = createOsAdapter(p.helper)
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

    runtime.on('exit', ({ code, signal }: { code: number | null; signal: string | null }) => {
      // Any exit while the app is running is unexpected: the runtime is meant
      // to outlive every task. Reporting only non-zero codes would hide both a
      // clean-but-premature exit and a failure to spawn at all.
      if (quitting) return
      const message = `The task runtime exited unexpectedly (code ${code}, signal ${signal}). Restarting it.`
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
      setTimeout(() => runtime.start(), 500)
    })
    runtime.start()

    registerIpc()

    petWindow = createPetWindow(
      { preload: p.preload, rendererUrl: RENDERER_URL, rendererFile: p.rendererFile },
      { x: settings.petX, y: settings.petY }
    )
    petWindow.on('moved', () => {
      const [x = -1, y = -1] = petWindow!.getPosition()
      saveSettings({ petX: x, petY: y })
    })

    panelWindow = createPanelWindow({ preload: p.preload, rendererUrl: RENDERER_URL, rendererFile: p.rendererFile })

    createTray()
    if (!registerShortcut(settings.shortcut)) {
      console.warn(`Could not register the global shortcut ${settings.shortcut}; it may be taken.`)
    }

    app.on('activate', () => togglePanel(true))
  })

  // Kibu lives in the menu bar, so closing its windows must not quit it.
  // Providing this handler and doing nothing is what keeps the app alive.
  app.on('window-all-closed', () => {})

  app.on('will-quit', async (event) => {
    event.preventDefault()
    quitting = true
    globalShortcut.unregisterAll()
    desktopSession?.dispose()
    await runtime?.stop()
    store?.close()
    app.exit(0)
  })
}

export { homedir }
