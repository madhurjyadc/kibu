import type { Questions, SystemOneResult, EntryType } from '@typesafe-ai/sdk'
import type { Evidence, TaskState, UserQuestion } from '../../shared/types.js'

/**
 * A workflow is a task shape we understand well enough to run without a
 * planning model: local code enumerates the options, and Jev makes the
 * judgment calls between them.
 *
 * The rule that keeps this honest: a workflow may only ever ask Jev to choose
 * between alternatives that local code has already constructed. If a step
 * needs a value invented — a sentence, a novel path, an unfamiliar plan — it
 * does not belong in a workflow, and the task goes to the planner instead.
 */
export interface WorkflowContext {
  task: TaskState
  /** Runs a registered tool through the full validate → verify → undo path. */
  run(tool: string, input: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }>
  /** Poses declared questions to Jev. Returns null when Jev is unavailable. */
  ask<const Q extends Questions>(
    label: string,
    state: EntryType,
    questions: Q
  ): Promise<SystemOneResult<Q>['answers'] | null>
  /** Pauses for the user; same mechanism the planner path uses. */
  askUser(q: Omit<UserQuestion, 'id'>): Promise<{ optionId: string | null; text?: string }>
  progress(line: string): void
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void
  checkpoint(): Promise<void>
  /** Folders this task may already work in, from drops or prior grants. */
  authorizedRoots(): string[]
}

export interface WorkflowResult {
  success: boolean
  headline: string
  evidence: Evidence[]
  /** Set when the workflow declined to handle the request after all. */
  handoffToPlanner?: string
  unresolved?: string
}

export interface Workflow {
  id: string
  /** Shown to Jev as a routing option; write it as a description of the job. */
  description: string
  /**
   * A cheap local check that this workflow could plausibly apply, used to
   * narrow the routing choices before Jev sees them.
   */
  plausible(request: string, droppedPaths: string[]): boolean
  run(request: string, droppedPaths: string[], ctx: WorkflowContext): Promise<WorkflowResult>
}
