/**
 * Core domain types shared by the renderer, the Electron main process and the
 * agent runtime. Everything here must be structured-clone friendly: it travels
 * over IPC and over the runtime's stdio channel.
 */

/** Runtime state of the pet. The sprite is driven from this, never faked. */
export type PetState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'finished'
  | 'failed'

export type TaskStatus =
  | 'pending'
  | 'observing'
  | 'planning'
  | 'awaiting_user'
  | 'executing'
  | 'verifying'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export const TASK_TERMINAL_STATUSES: TaskStatus[] = ['succeeded', 'failed', 'cancelled']

export function isTerminal(status: TaskStatus): boolean {
  return TASK_TERMINAL_STATUSES.includes(status)
}

/**
 * What the user has authorized for one task. This is *task authorization*, which
 * is deliberately separate from OS-level permission grants (see OsPermission).
 * A tool call is only executed when it falls inside this grant.
 */
export interface Authorization {
  /** Absolute directory paths the task may read. */
  readRoots: string[]
  /** Absolute directory paths the task may create/move/rename inside. */
  writeRoots: string[]
  /** Bundle ids / app names the task may drive. */
  apps: string[]
  /** Origins the managed browser may visit, or ['*'] once the user opts in. */
  origins: string[]
  /**
   * Capability names the task may use without a further prompt, e.g.
   * 'files.move'. Actions outside this set trigger an ask_user step.
   */
  capabilities: string[]
}

export function emptyAuthorization(): Authorization {
  return { readRoots: [], writeRoots: [], apps: [], origins: [], capabilities: [] }
}

/** Hard bounds enforced by local code, never by the model. */
export interface TaskLimits {
  maxSteps: number
  maxWallClockMs: number
  maxUsd: number
  maxConsecutiveFailures: number
}

export function defaultLimits(): TaskLimits {
  return {
    maxSteps: 40,
    maxWallClockMs: 10 * 60 * 1000,
    maxUsd: 1.5,
    maxConsecutiveFailures: 3
  }
}

/** A timestamped fact the runtime gathered about the machine. */
export interface Observation {
  id: string
  kind: 'files' | 'window' | 'page' | 'screen' | 'user'
  /** Human summary shown in the activity log. */
  summary: string
  /** Structured payload the model may read. Kept small on purpose. */
  data: unknown
  observedAt: number
  /** Milliseconds after which this observation must be refreshed before use. */
  staleAfterMs: number
}

export function isStale(o: Observation, now = Date.now()): boolean {
  return now - o.observedAt > o.staleAfterMs
}

export interface PlanStep {
  id: string
  description: string
  status: 'pending' | 'active' | 'done' | 'skipped' | 'failed'
}

/** One executed tool call and what actually happened. */
export interface ActionRecord {
  id: string
  step: number
  tool: string
  input: unknown
  startedAt: number
  finishedAt?: number
  outcome: 'success' | 'failure' | 'uncertain'
  /** Present on success. */
  result?: unknown
  /** Present on failure. */
  error?: string
  /** Result of the tool's own verification pass. */
  verification?: VerificationResult
  /** Set when the action is reversible; consumed by the undo system. */
  undo?: UndoEntry
}

export interface VerificationResult {
  verified: boolean
  method: string
  detail: string
}

/**
 * A reversible effect. We only record these for operations we can genuinely
 * reverse; there is no universal undo.
 */
export interface UndoEntry {
  kind: 'file.move' | 'file.rename' | 'folder.create'
  /** Enough information to reverse the operation and to detect conflicts. */
  payload: { from: string; to: string }
  reversed?: boolean
}

export interface CostRecord {
  inputTokens: number
  outputTokens: number
  usd: number
  calls: number
}

export interface TaskState {
  id: string
  /** Verbatim user instruction. */
  request: string
  /** The model's restatement of the outcome, confirmed against the request. */
  outcome: string
  status: TaskStatus
  petState: PetState
  authorization: Authorization
  limits: TaskLimits
  observations: Observation[]
  plan: PlanStep[]
  actions: ActionRecord[]
  cost: CostRecord
  /** Criteria the verifier checks before the task may be called complete. */
  completionCriteria: string[]
  /** Short status line shown in the pet's speech bubble. */
  statusLine: string
  createdAt: number
  updatedAt: number
  /** Set when status is 'awaiting_user'. */
  question?: UserQuestion
  /** Set when status is terminal. */
  summary?: TaskSummary
  error?: string
}

export interface UserQuestion {
  id: string
  /** Why the runtime stopped: an ambiguity, or an authorization gap. */
  reason: 'ambiguous' | 'authorization' | 'blocked'
  prompt: string
  options?: { id: string; label: string; detail?: string }[]
  /** A preview of the change being proposed, when there is one. */
  preview?: PreviewPayload
  /** Free text is accepted when true. */
  allowFreeText: boolean
}

export interface PreviewPayload {
  title: string
  /** Proposed file operations, shown as a before/after list. */
  fileOps?: { from: string; to: string; kind: string }[]
  note?: string
}

export interface TaskSummary {
  headline: string
  /** Evidence the user can click through: folders, files, URLs. */
  evidence: Evidence[]
  undoable: boolean
}

export interface Evidence {
  kind: 'path' | 'url' | 'text'
  label: string
  value: string
}

/** OS-level permission grants, distinct from per-task authorization. */
export type OsPermission = 'accessibility' | 'screen-recording' | 'automation' | 'full-disk'

export interface PermissionStatus {
  permission: OsPermission
  granted: boolean
  /** Why Kibu needs it, shown verbatim in the UI. */
  purpose: string
}
