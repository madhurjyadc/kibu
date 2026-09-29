import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BrainSnapshot } from '../shared/brain.js'
import { IPC } from '../shared/protocol.js'
import type {
  AnswerQuestionRequest,
  KibuBridge,
  LogEntry,
  Memory,
  PanelState,
  PetPlay,
  PetState,
  Settings,
  StartTaskRequest,
  TaskState
} from '../shared/protocol.js'

/**
 * The bridge.
 *
 * This is the entire surface the renderer can reach. It exposes named calls
 * only — no ipcRenderer, no Node, no filesystem. Every call lands on a main
 * process handler that validates its arguments before anything happens.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: KibuBridge & { getPathForFile(file: File): string } = {
  getBrain: () => ipcRenderer.invoke(IPC.brainGet),
  brainRequest: (req) => ipcRenderer.invoke(IPC.brainRequest, req),
  openBrain: () => ipcRenderer.invoke(IPC.brainOpen),
  onBrainChanged: (cb) => subscribe<BrainSnapshot>(IPC.onBrain, cb),
  onBrainOpen: (cb) => subscribe<void>(IPC.onBrainOpen, cb),
  startTask: (req: StartTaskRequest) => ipcRenderer.invoke(IPC.taskStart, req),
  pauseTask: (taskId) => ipcRenderer.invoke(IPC.taskPause, taskId),
  resumeTask: (taskId) => ipcRenderer.invoke(IPC.taskResume, taskId),
  cancelTask: (taskId) => ipcRenderer.invoke(IPC.taskCancel, taskId),
  answerQuestion: (req: AnswerQuestionRequest) => ipcRenderer.invoke(IPC.taskAnswer, req),
  undoTask: (taskId) => ipcRenderer.invoke(IPC.taskUndo, taskId),
  getTask: (taskId) => ipcRenderer.invoke(IPC.taskGet, taskId),
  deleteTask: (id) => ipcRenderer.invoke(IPC.historyDelete, id),
  clearHistory: () => ipcRenderer.invoke(IPC.historyClear),
  choosePaths: () => ipcRenderer.invoke(IPC.choosePaths),
  onHistoryDeleted: (cb) => subscribe<string[]>(IPC.onHistoryDeleted, cb),
  listMemories: () => ipcRenderer.invoke(IPC.memoriesList),
  deleteMemory: (id) => ipcRenderer.invoke(IPC.memoryDelete, id),
  clearMemories: () => ipcRenderer.invoke(IPC.memoriesClear),
  onMemoriesChanged: (cb) => subscribe<Memory[]>(IPC.onMemories, cb),
  listHistory: (limit) => ipcRenderer.invoke(IPC.historyList, limit),
  getPermissions: () => ipcRenderer.invoke(IPC.permissionsGet),
  requestPermission: (p) => ipcRenderer.invoke(IPC.permissionsRequest, p),
  getSetup: () => ipcRenderer.invoke(IPC.setupGet),
  requestSetup: (id) => ipcRenderer.invoke(IPC.setupRequest, id),
  openSetupSettings: (id) => ipcRenderer.invoke(IPC.setupOpenSettings, id),
  setApiKey: (key) => ipcRenderer.invoke(IPC.secretsSet, key),
  hasApiKey: () => ipcRenderer.invoke(IPC.secretsStatus),
  setJevKey: (key) => ipcRenderer.invoke(IPC.secretsSetJev, key),
  hasJevKey: () => ipcRenderer.invoke(IPC.secretsStatusJev),
  hasClaudeCode: () => ipcRenderer.invoke(IPC.claudeCodeStatus),
  codingApps: () => ipcRenderer.invoke(IPC.codingAppsStatus),
  canWork: () => ipcRenderer.invoke(IPC.canWork),
  runBench: () => ipcRenderer.invoke(IPC.benchRun),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (s: Partial<Settings>) => ipcRenderer.invoke(IPC.settingsSet, s),
  revealPath: (p) => ipcRenderer.invoke(IPC.revealPath, p),
  openPath: (p) => ipcRenderer.invoke(IPC.openPath, p),
  openUrl: (url) => ipcRenderer.invoke(IPC.openUrl, url),
  resizePanel: (h) => ipcRenderer.invoke(IPC.panelResize, h),
  closePanel: () => ipcRenderer.invoke(IPC.panelClose),
  centerPanel: () => ipcRenderer.invoke(IPC.panelCenter),
  petCompose: (text: string) => ipcRenderer.invoke(IPC.petCompose, text),
  showPetMenu: (napping: boolean) => ipcRenderer.invoke(IPC.petMenu, napping),
  onPetPlay: (cb) => subscribe<PetPlay>(IPC.onPetPlay, cb),
  onPetPresence: (cb) => subscribe<boolean>(IPC.onPetPresence, cb),
  onSeed: (cb) => subscribe<string>(IPC.onSeed, cb),
  dragPanel: (phase: 'start' | 'move' | 'end') => ipcRenderer.invoke(IPC.panelDrag, phase),
  minimizePanel: () => ipcRenderer.invoke(IPC.panelMinimize),
  pinPanel: (pinned: boolean) => ipcRenderer.invoke(IPC.panelPin, pinned),
  getPanelState: () => ipcRenderer.invoke(IPC.panelStateGet),
  petClicked: (pressedAt?: number) => ipcRenderer.invoke(IPC.petClicked, pressedAt),
  /** Holds the pet solid to the mouse (during a drag or a file drop), or releases it. */
  setPetInteractive: (v: boolean) => ipcRenderer.invoke(IPC.petInteractive, v),
  /** Where the creature and its bubble are, so main can decide what catches the mouse. */
  setPetHitRects: (rects: { x: number; y: number; width: number; height: number }[]) => ipcRenderer.invoke(IPC.petHitRects, rects),
  dragPet: (dx: number, dy: number) => ipcRenderer.invoke(IPC.petDrag, { dx, dy }),
  reportDroppedPaths: (paths: string[]) => ipcRenderer.invoke(IPC.petDropped, paths),
  stopDesktopSession: () => ipcRenderer.invoke(IPC.desktopStop),
  getFrontWindow: () => ipcRenderer.invoke(IPC.frontWindowGet),

  onTaskUpdate: (cb) => subscribe<TaskState>(IPC.onTaskUpdate, cb),
  onPetState: (cb) => subscribe<PetState>(IPC.onPetState, cb),
  onLog: (cb) => subscribe<LogEntry>(IPC.onLog, cb),
  onDroppedPaths: (cb) => subscribe<string[]>(IPC.onDroppedPaths, cb),
  onFocusInput: (cb) => subscribe<void>(IPC.onFocusInput, () => cb()),
  onPanelState: (cb) => subscribe<PanelState>(IPC.onPanelState, cb),
  onDesktopSession: (cb) => subscribe<boolean>(IPC.onDesktopSession, cb),
  onCursor: (cb) => subscribe<{ dx: number; dy: number }>(IPC.onCursor, cb),

  // Electron no longer exposes File.path; this is the supported replacement
  // and is the only way the renderer learns a dropped file's location.
  getPathForFile: (file: File) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('kibu', bridge)
