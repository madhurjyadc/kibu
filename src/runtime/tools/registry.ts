import { z } from 'zod'
import type { OsAdapter } from '../../os/adapter.js'
import type {
  Evidence,
  Observation,
  PreviewPayload,
  TaskState,
  UndoEntry,
  UserQuestion,
  VerificationResult
} from '../../shared/types.js'

/**
 * What a tool needs from the world. Handing tools a context object (rather
 * than letting them import globals) is what makes them testable and keeps the
 * privileged surface enumerable.
 */
export interface ToolContext {
  task: TaskState
  os: OsAdapter
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void
  /** Short line for the pet's speech bubble. */
  progress(line: string): void
  /** Records an observation on the task and returns it. */
  observe(o: Omit<Observation, 'id' | 'observedAt'>): Observation
  /** Suspends the loop until the user answers. Resolves with their answer. */
  ask(question: Omit<UserQuestion, 'id'>): Promise<{ optionId: string | null; text?: string }>
  /** Throws if the task has been cancelled; awaits while paused. */
  checkpoint(): Promise<void>
  /** Claims the exclusive desktop-control session for GUI automation. */
  claimDesktop(reason: string): Promise<void>
  releaseDesktop(): void
  browser: BrowserSession
}

/** Implemented in tools/browser.ts; declared here to avoid a cycle. */
export interface BrowserSession {
  page(): Promise<import('playwright').Page>
  isOpen(): boolean
  close(): Promise<void>
}

/** A scope the tool needs before it may run, checked against task authorization. */
export type ScopeRequest =
  | { kind: 'read'; path: string }
  | { kind: 'write'; path: string }
  | { kind: 'app'; name: string }
  | { kind: 'origin'; url: string }
  | { kind: 'capability'; name: string }

export interface ToolOutcome<O = unknown> {
  result: O
  /** Reversible effects produced by this call. */
  undo?: UndoEntry[]
  /** Things the user can click through in the result panel. */
  evidence?: Evidence[]
  /** A preview to show instead of acting, when the tool is in dry-run mode. */
  preview?: PreviewPayload
  /**
   * Set when the tool cannot tell whether the effect landed (e.g. a form
   * submit that timed out). The loop treats these as unsafe to retry blindly.
   */
  uncertain?: boolean
}

export interface ToolDefinition<I = any, O = unknown> {
  name: string
  /** Shown to the planning model. Write it for a reader who cannot see the code. */
  description: string
  input: z.ZodType<I>
  /** Capability name gating this tool, e.g. 'files.move'. */
  capability: string
  /** True when the tool drives the user's real screen, keyboard or mouse. */
  exclusiveDesktop?: boolean
  /** Scopes derived from the concrete input, checked before execution. */
  scopes(input: I): ScopeRequest[]
  /** Cheap checks that make failure legible before anything is changed. */
  precondition?(input: I, ctx: ToolContext): Promise<void>
  execute(input: I, ctx: ToolContext): Promise<ToolOutcome<O>>
  /**
   * Independent confirmation that the effect actually happened. A tool that
   * returns success without a verifier can never complete a task on its own.
   */
  verify?(input: I, outcome: ToolOutcome<O>, ctx: ToolContext): Promise<VerificationResult>
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const t of tools) this.register(t)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * Tools offered for one task. Availability is scoped deliberately: a task
   * that only sorts files is never shown the browser or input-synthesis tools.
   */
  forTask(allowedCapabilities: string[]): ToolDefinition[] {
    return [...this.tools.values()].filter((t) =>
      allowedCapabilities.some((c) => c === t.capability || c === '*' || t.capability.startsWith(`${c}.`))
    )
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  /** Anthropic tool-use schema for the planning model. */
  toModelSchema(tools: ToolDefinition[]): { name: string; description: string; input_schema: object }[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: z.toJSONSchema(t.input, { io: 'input', target: 'draft-7' }) as object
    }))
  }
}
