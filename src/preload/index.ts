import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/protocol.js'
import type {
  AnswerQuestionRequest,
  KibuBridge,
  LogEntry,
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
  listHistory: (limit) => ipcRenderer.invoke(IPC.historyList, limit),
  getPermissions: () => ipcRenderer.invoke(IPC.permissionsGet),
  requestPermission: (p) => ipcRenderer.invoke(IPC.permissionsRequest, p),
  setApiKey: (key) => ipcRenderer.invoke(IPC.secretsSet, key),
  hasApiKey: () => ipcRenderer.invoke(IPC.secretsStatus),
  setJevKey: (key) => ipcRenderer.invoke(IPC.secretsSetJev, key),
  hasJevKey: () => ipcRenderer.invoke(IPC.secretsStatusJev),
  hasClaudeCode: () => ipcRenderer.invoke(IPC.claudeCodeStatus),
  canWork: () => ipcRenderer.invoke(IPC.canWork),
  runBench: () => ipcRenderer.invoke(IPC.benchRun),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (s: Partial<Settings>) => ipcRenderer.invoke(IPC.settingsSet, s),
  revealPath: (p) => ipcRenderer.invoke(IPC.revealPath, p),
  openPath: (p) => ipcRenderer.invoke(IPC.openPath, p),
  openUrl: (url) => ipcRenderer.invoke(IPC.openUrl, url),
  resizePanel: (h) => ipcRenderer.invoke(IPC.panelResize, h),
  closePanel: () => ipcRenderer.invoke(IPC.panelClose),
  setSticky: (sticky: boolean) => ipcRenderer.invoke(IPC.panelSticky, sticky),
  petClicked: () => ipcRenderer.invoke(IPC.petClicked),
  setPetInteractive: (v: boolean) => ipcRenderer.invoke(IPC.petInteractive, v),
  dragPet: (dx: number, dy: number) => ipcRenderer.invoke(IPC.petDrag, { dx, dy }),
  reportDroppedPaths: (paths: string[]) => ipcRenderer.invoke(IPC.petDropped, paths),
  stopDesktopSession: () => ipcRenderer.invoke(IPC.desktopStop),
  getFrontWindow: () => ipcRenderer.invoke(IPC.frontWindowGet),

  onTaskUpdate: (cb) => subscribe<TaskState>(IPC.onTaskUpdate, cb),
  onPetState: (cb) => subscribe<PetState>(IPC.onPetState, cb),
  onLog: (cb) => subscribe<LogEntry>(IPC.onLog, cb),
  onDroppedPaths: (cb) => subscribe<string[]>(IPC.onDroppedPaths, cb),
  onFocusInput: (cb) => subscribe<void>(IPC.onFocusInput, () => cb()),
  onDesktopSession: (cb) => subscribe<boolean>(IPC.onDesktopSession, cb),

  // Electron no longer exposes File.path; this is the supported replacement
  // and is the only way the renderer learns a dropped file's location.
  getPathForFile: (file: File) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('kibu', bridge)
