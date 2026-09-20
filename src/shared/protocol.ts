/**
 * Wire protocol.
 *
 *   renderer  --(preload bridge)-->  main  --(stdio JSON lines)-->  runtime
 *
 * The renderer is unprivileged: it can only send the commands named here, and
 * every one is validated in the main process before anything privileged runs.
 */
import type {
  Authorization,
  Evidence,
  Observation,
  PetState,
  PermissionStatus,
  PlanStep,
  PreviewPayload,
  TaskState,
  TaskStatus,
  UserQuestion
} from './types.js'

/* ------------------------------------------------------------------ *
 * renderer -> main
 * ------------------------------------------------------------------ */

export interface StartTaskRequest {
  request: string
  /** Paths dropped onto the pet, which seed the task's authorization. */
  droppedPaths?: string[]
  /** Set when the request came from "help me with this window". */
  includeFrontWindow?: boolean
}

export interface AnswerQuestionRequest {
  taskId: string
  questionId: string
  /** Id of the chosen option, or null when answering with free text. */
  optionId: string | null
  text?: string
  /** User approval of an authorization expansion, when one was requested. */
  grant?: Partial<Authorization>
}

/** Channel names. Kept as consts so the preload and main cannot drift. */
export const IPC = {
  // invoke
  taskStart: 'task:start',
  taskPause: 'task:pause',
  taskResume: 'task:resume',
  taskCancel: 'task:cancel',
  taskAnswer: 'task:answer',
  taskUndo: 'task:undo',
  taskGet: 'task:get',
  historyList: 'history:list',
  permissionsGet: 'permissions:get',
  permissionsRequest: 'permissions:request',
  secretsSet: 'secrets:set',
  secretsStatus: 'secrets:status',
  secretsSetJev: 'secrets:set-jev',
  secretsStatusJev: 'secrets:status-jev',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  revealPath: 'shell:reveal',
  openPath: 'shell:open',
  panelResize: 'panel:resize',
  panelClose: 'panel:close',
  petDrag: 'pet:drag',
  petDropped: 'pet:dropped-paths',
  petClicked: 'pet:clicked',
  desktopStop: 'desktop:stop',
  frontWindowGet: 'window:front',
  // main -> renderer (send)
  onTaskUpdate: 'task:update',
  onPetState: 'pet:state',
  onLog: 'task:log',
  onDroppedPaths: 'pet:dropped',
  onFocusInput: 'panel:focus-input',
  onDesktopSession: 'desktop:session'
} as const

/* ------------------------------------------------------------------ *
 * main <-> runtime (newline-delimited JSON over an IPC channel)
 * ------------------------------------------------------------------ */

export type HostToRuntime =
  | {
      type: 'start'
      task: TaskState
      /** Anthropic key, for the planning model. */
      apiKey: string | null
      /** TypeSafe AI key, for Jev. A different provider, a different key. */
      jevApiKey: string | null
      model: ModelConfig
      /**
       * The window that was frontmost before Kibu's own panel took focus.
       * Captured by the host, because by the time a task starts the frontmost
       * application is Kibu itself.
       */
      frontWindow: FrontWindow | null
      /** Ask before every action, even inside an existing authorization. */
      confirmEveryAction: boolean
      /** Try the no-planner Jev workflows before the planning model. */
      workflowsEnabled: boolean
    }
  | { type: 'pause'; taskId: string }
  | { type: 'resume'; taskId: string }
  | { type: 'cancel'; taskId: string }
  | { type: 'answer'; taskId: string; answer: AnswerPayload }
  | { type: 'tool-result'; callId: string; ok: boolean; value?: unknown; error?: string }
  | { type: 'shutdown' }

export interface AnswerPayload {
  questionId: string
  optionId: string | null
  text?: string
  grant?: Partial<Authorization>
}

export type RuntimeToHost =
  | { type: 'ready' }
  | { type: 'task-update'; task: TaskState }
  | { type: 'pet-state'; state: PetState }
  | { type: 'log'; entry: LogEntry }
  /** The runtime asks the host to run a privileged tool on its behalf. */
  | { type: 'tool-call'; callId: string; tool: string; input: unknown; taskId: string }
  /** The runtime is about to drive the real screen, keyboard or mouse. */
  | { type: 'desktop-claim'; taskId: string; reason: string }
  | { type: 'desktop-release'; taskId: string }
  | { type: 'error'; message: string; fatal: boolean }

export interface LogEntry {
  taskId: string
  at: number
  level: 'debug' | 'info' | 'warn' | 'error'
  /** Which subsystem produced this: 'loop' | 'tool:files.move' | 'model' ... */
  source: string
  message: string
  data?: unknown
}

export interface FrontWindow {
  pid: number
  name: string
  title: string
}

export interface ModelConfig {
  /** Planning / vision model, called through the Anthropic API. */
  planner: string
  /** Jev model id, called through the TypeSafe AI API. */
  jev: string
  maxTokens: number
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  planner: 'claude-opus-5',
  jev: 'jev-latest',
  maxTokens: 16000
}

/* ------------------------------------------------------------------ *
 * The API the preload bridge exposes on window.kibu
 * ------------------------------------------------------------------ */

export interface KibuBridge {
  startTask(req: StartTaskRequest): Promise<TaskState>
  pauseTask(taskId: string): Promise<void>
  resumeTask(taskId: string): Promise<void>
  cancelTask(taskId: string): Promise<void>
  answerQuestion(req: AnswerQuestionRequest): Promise<void>
  undoTask(taskId: string): Promise<UndoReport>
  getTask(taskId: string): Promise<TaskState | null>
  listHistory(limit?: number): Promise<TaskSummaryRow[]>
  getPermissions(): Promise<PermissionStatus[]>
  requestPermission(p: string): Promise<PermissionStatus>
  setApiKey(key: string): Promise<boolean>
  hasApiKey(): Promise<boolean>
  setJevKey(key: string): Promise<boolean>
  hasJevKey(): Promise<boolean>
  getSettings(): Promise<Settings>
  setSettings(s: Partial<Settings>): Promise<Settings>
  revealPath(p: string): Promise<void>
  openPath(p: string): Promise<void>
  resizePanel(height: number): Promise<void>
  closePanel(): Promise<void>
  petClicked(): Promise<void>
  dragPet(dx: number, dy: number): Promise<void>
  reportDroppedPaths(paths: string[]): Promise<void>
  stopDesktopSession(): Promise<void>
  getFrontWindow(): Promise<FrontWindow | null>
  onTaskUpdate(cb: (t: TaskState) => void): () => void
  onPetState(cb: (s: PetState) => void): () => void
  onLog(cb: (e: LogEntry) => void): () => void
  onDroppedPaths(cb: (paths: string[]) => void): () => void
  onFocusInput(cb: () => void): () => void
  onDesktopSession(cb: (active: boolean) => void): () => void
}

export interface UndoReport {
  reversed: number
  skipped: { path: string; reason: string }[]
}

export interface TaskSummaryRow {
  id: string
  request: string
  status: TaskStatus
  headline: string
  createdAt: number
  undoable: boolean
}

export interface Settings {
  /** Global shortcut accelerator, Electron syntax. */
  shortcut: string
  /** Per-task spend ceiling in USD. */
  maxUsdPerTask: number
  /** Whether Jev (fast structured decisions) is enabled. */
  jevEnabled: boolean
  /**
   * Handle known task shapes with code plus Jev, with no planning model call.
   * Faster and far cheaper; falls back to the planner for anything else.
   */
  workflowsFirst: boolean
  /** Ask before every action, even inside an existing authorization. */
  confirmEveryAction: boolean
  petX: number
  petY: number
}

export const DEFAULT_SETTINGS: Settings = {
  shortcut: 'CommandOrControl+Shift+K',
  maxUsdPerTask: 1.5,
  jevEnabled: true,
  workflowsFirst: true,
  confirmEveryAction: false,
  petX: -1,
  petY: -1
}

export type {
  Authorization,
  Evidence,
  Observation,
  PetState,
  PermissionStatus,
  PlanStep,
  PreviewPayload,
  TaskState,
  TaskStatus,
  UserQuestion
}
