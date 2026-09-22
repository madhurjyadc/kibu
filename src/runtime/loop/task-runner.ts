import { randomUUID } from 'node:crypto'
import type { ZodType } from 'zod'
import { Planner, addCost, type PlannerLike } from '../model/planner.js'
import { Jev, summarizeJev } from '../model/jev.js'
import { routeToWorkflow, type WorkflowContext } from '../workflows/index.js'
import { describeSelf, isAboutKibu } from './about.js'
import { fallbackUnderstanding, routeFor, understand, type Understanding } from '../model/understand.js'
import { evaluateArithmetic } from './calculate.js'
import { basename } from 'node:path'
import { checkScopes, describeMissing, extendAuthorization, grantFor, normalizePath } from '../authorization.js'
import { clearElementCache } from '../tools/desktop.js'
import type { BrowserSession, ScopeRequest, ToolContext, ToolDefinition, ToolRegistry } from '../tools/registry.js'
import type { OsAdapter } from '../../os/adapter.js'
import { StaleElementError, UnsupportedCapabilityError } from '../../os/adapter.js'
import type {
  ActionRecord,
  Evidence,
  Observation,
  PetState,
  TaskState,
  UndoEntry,
  UserQuestion,
  VerificationResult
} from '../../shared/types.js'
import type { AnswerPayload, FrontWindow, LogEntry, ModelConfig, PreviousTurn } from '../../shared/protocol.js'

export class CancelledError extends Error {
  constructor() {
    super('task cancelled')
    this.name = 'CancelledError'
  }
}

export class LimitExceededError extends Error {
  constructor(public readonly limit: string, message: string) {
    super(message)
    this.name = 'LimitExceededError'
  }
}

export interface RunnerHooks {
  onUpdate(task: TaskState): void
  onPetState(state: PetState): void
  onLog(entry: LogEntry): void
  /** Called when the runtime wants exclusive control of the real desktop. */
  claimDesktop(taskId: string, reason: string): Promise<void>
  releaseDesktop(taskId: string): void
}

export interface RunnerDeps {
  os: OsAdapter
  browser: BrowserSession
  registry: ToolRegistry
  model: ModelConfig
  apiKey: string | null
  jevEnabled: boolean
  /** TypeSafe AI key for Jev. Separate from the planning model's key. */
  jevApiKey: string | null
  /** Try the no-planner workflows before falling back to the planning model. */
  workflowsEnabled: boolean
  droppedPaths: string[]
  frontWindow: FrontWindow | null
  /** The exchange just before this one, when there was a recent one. */
  previousTurn: PreviousTurn | null
  confirmEveryAction: boolean
  /** Overrides the planning model. Used to swap providers, and by tests. */
  createPlanner?: () => PlannerLike
  /** Transport override for Jev. Used to exercise workflows without a network. */
  jevFetch?: import('@typesafe-ai/sdk').Fetch
}

/** A reply that talks about answering rather than answering. */
export function isNarration(text: string): boolean {
  return /^\s*(?:i(?:'m| am) )?(?:answering|responding|replying)\b|^\s*no (?:tools?|actions?|steps?) (?:are )?(?:needed|required)/i.test(text)
}

/** Which tool capabilities each route unlocks. Tool availability is scoped. */
const ROUTE_CAPABILITIES: Record<string, string[]> = {
  files: ['files', 'shell', 'user.interact'],
  desktop: ['files.read', 'shell', 'desktop', 'user.interact'],
  browser: ['files.read', 'browser', 'user.interact'],
  mixed: ['files', 'shell', 'desktop', 'browser', 'user.interact'],
  unclear: ['files', 'shell', 'desktop', 'browser', 'user.interact']
}

export class TaskRunner {
  private plannerInstance: PlannerLike | null = null
  private jev: Jev
  private cancelled = false
  private paused = false
  private pauseGate: Promise<void> = Promise.resolve()
  private releasePause: (() => void) | null = null
  private pendingQuestion: {
    question: UserQuestion
    resolve: (a: { optionId: string | null; text?: string }) => void
  } | null = null
  private undoStack: UndoEntry[] = []
  /**
   * File operations the user explicitly rejected in a preview. Enforced in
   * code: telling the model "they said no" is not enough, because the model
   * is exactly the component that might ignore it.
   */
  private rejectedOps = new Set<string>()
  private evidence: Evidence[] = []
  private startedAt = Date.now()
  private holdsDesktop = false
  /** How this request was read. Computed once, in understand(). */
  private read: Understanding | null = null

  constructor(
    public readonly task: TaskState,
    private readonly deps: RunnerDeps,
    private readonly hooks: RunnerHooks
  ) {
    // The planner is built on first use, so a task handled entirely by a
    // workflow never constructs it — and never needs an Anthropic key.
    this.jev = new Jev(deps.jevApiKey, deps.jevEnabled, deps.model.jev, deps.jevFetch)
  }

  /** Builds the planning model on first use. Throws if no key is configured. */
  private get planner(): PlannerLike {
    if (!this.plannerInstance) {
      this.plannerInstance =
        this.deps.createPlanner?.() ??
        new Planner(this.deps.model.planner, this.deps.model.maxTokens, this.deps.apiKey)
    }
    return this.plannerInstance
  }

  /* ---------------------------------------------------------------- *
   * External control
   * ---------------------------------------------------------------- */

  pause(): void {
    if (this.paused || this.isFinished()) return
    this.paused = true
    this.pauseGate = new Promise((resolve) => {
      this.releasePause = resolve
    })
    this.setStatus('paused', 'Paused')
    this.hooks.onPetState('waiting')
    // Holding the user's keyboard and mouse while paused would be rude.
    this.dropDesktop()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.releasePause?.()
    this.releasePause = null
    this.setStatus('executing', 'Picking up where I left off')
  }

  cancel(): void {
    this.cancelled = true
    this.resume()
    // A question in flight must not keep the loop waiting forever.
    this.pendingQuestion?.resolve({ optionId: null, text: '__cancelled__' })
    this.pendingQuestion = null
    this.dropDesktop()
  }

  answer(payload: AnswerPayload): void {
    const pending = this.pendingQuestion
    if (!pending || pending.question.id !== payload.questionId) return
    this.pendingQuestion = null
    if (payload.grant) {
      this.task.authorization = extendAuthorization(this.task.authorization, payload.grant)
      this.log('info', 'authorization', 'user granted additional access', payload.grant)
    }
    delete this.task.question
    pending.resolve({ optionId: payload.optionId, text: payload.text })
  }

  /* ---------------------------------------------------------------- *
   * The loop
   * ---------------------------------------------------------------- */

  async run(): Promise<TaskState> {
    try {
      // Arithmetic is not a task. It is answered exactly, instantly, by code.
      const value = evaluateArithmetic(this.task.request)
      if (value !== null) {
        this.answerArithmetic(value)
        return this.task
      }
      // "What can you do?" is a question about this build, not a task. It is
      // answered from the tool registry and the real permission state, in no
      // time and at no cost, rather than by asking a model to describe itself.
      if (isAboutKibu(this.task.request)) {
        this.answerAboutSelf()
        return this.task
      }
      await this.understand()
      // A known task shape is handled by code plus Jev, with no planning
      // model involved at all. Only novel requests reach the planner.
      const handled = await this.tryWorkflow()
      if (!handled) await this.loop()
    } catch (err) {
      if (err instanceof CancelledError) {
        this.setStatus('cancelled', 'Stopped')
        this.hooks.onPetState('idle')
        this.task.summary = {
          headline: 'Stopped before finishing',
          evidence: this.evidence,
          undoable: this.undoStack.length > 0
        }
      } else {
        const message = err instanceof Error ? err.message : String(err)
        this.task.error = message
        this.setStatus('failed', 'Something went wrong')
        this.hooks.onPetState('failed')
        this.task.summary = {
          headline: err instanceof LimitExceededError ? message : `Could not finish: ${message}`,
          evidence: this.evidence,
          undoable: this.undoStack.length > 0
        }
        this.log('error', 'loop', message)
      }
    } finally {
      await this.tidyBrowser()
      this.dropDesktop()
      clearElementCache(this.task.id)
      this.log('info', 'jev', summarizeJev(this.jev.metrics), this.jev.metrics)
      this.emit()
    }
    return this.task
  }

  /**
   * Shuts the browser when the job it was opened for is over.
   *
   * Leaving a Chromium window sitting on the desktop after every web task is
   * litter. Local rules decide the clear cases — the user asking to *open*
   * something wants it left open; a task that failed leaves it up so they can
   * see where it got to — and Jev is asked only in the ambiguous middle,
   * choosing between two outcomes this code has already defined.
   */
  private async tidyBrowser(): Promise<void> {
    if (!this.deps.browser.isOpen()) return
    const request = this.task.request.toLowerCase()

    // They asked for a window; leave them the window.
    if (/\b(open|show|leave|keep|pull up|bring up|log ?in|sign ?in)\b/.test(request)) return
    // It did not finish: the half-done page is the evidence.
    if (this.task.status !== 'succeeded') return

    const verdict = await this.jev.shouldCloseBrowser(this.task.request)
    if (!verdict) return
    try {
      await this.deps.browser.close()
      this.log('info', 'browser', 'closed the browser now the task is done')
    } catch (err) {
      // Failing to tidy up must never fail the task.
      this.log('warn', 'browser', `could not close the browser: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Answers a sum in place, with no routing, no workflow and no model. */
  private answerArithmetic(value: number): void {
    this.setStatus('succeeded', 'Worked it out')
    this.hooks.onPetState('finished')
    this.task.summary = { headline: `${this.task.request.trim()} = ${value}`, evidence: [], undoable: false }
    this.log('info', 'loop', `answered arithmetic locally: ${value}`)
    this.emit()
  }

  /** Answers a question about Kibu itself, with no model call at all. */
  private answerAboutSelf(): void {
    const self = describeSelf(this.deps.os, this.canPlan(), this.deps.workflowsEnabled)
    this.evidence = self.evidence
    this.setStatus('succeeded', 'Said hello')
    this.hooks.onPetState('finished')
    this.task.summary = { headline: self.headline, evidence: self.evidence, undoable: false }
    this.log('info', 'loop', 'answered a question about Kibu locally; no model call')
    this.emit()
  }

  /** Step 1: understand the request well enough to scope the toolset. */
  private async understand(): Promise<void> {
    this.setStatus('observing', 'Reading your request')
    this.hooks.onPetState('thinking')
    // One structured reading of the request, used by routing and by every
    // workflow after it. Local rules answer only the cases they are certain
    // about; anything that needs English understood goes to Jev, in a single
    // call that answers every question at once.
    this.read = await understand(this.task.request, this.jev, this.deps.droppedPaths.length > 0)
    const route = routeFor(this.read)
    this.log(
      'info',
      'jev',
      `read as ${this.read.action}/${this.read.kind}/${this.read.size}/${this.read.when} (${this.read.source}) → route "${route.route}"`,
      this.read
    )

    // A short follow-up after a recent exchange is a continuation, not a
    // vague request. Asking "what do you mean?" when the user just told you
    // is the single most annoying thing this loop can do.
    const following = this.deps.previousTurn !== null
    if (route.needsClarification && !following) {
      const answer = await this.ask({
        reason: 'ambiguous',
        prompt: `I want to get this right — what would you like me to do?\n\nYou asked: "${this.task.request}"`,
        allowFreeText: true
      })
      if (answer.text) {
        this.task.request = `${this.task.request}\n\nClarification: ${answer.text}`
      }
    }

    if (this.deps.frontWindow) await this.observeFrontWindow(this.deps.frontWindow)

    this.task.outcome = this.task.request
    if (this.canPlan()) {
      this.planner.seed(this.task, this.deps.droppedPaths)
      const prev = this.deps.previousTurn
      if (prev) {
        this.planner.addNote(
          `${prev.secondsAgo}s ago the user asked: "${prev.request}". You answered: "${prev.headline}". ` +
            `This message is very likely a follow-up to that. Read it that way before considering it vague, ` +
            `and do not ask them to repeat something they have already told you.`
        )
      }
      const missing = this.missingCapabilities()
      // Told up front, so it says what it needs instead of calling a tool that
      // is going to fail and guessing from the wreckage.
      if (missing) this.planner.addNote(missing)
    }
    ;(this.task as TaskState & { route?: string }).route = route.route
  }

  /**
   * Backs "help me with this window".
   *
   * Looking at a window is not permission to drive it, so this records an
   * observation and authorizes reading that app only. Any action still goes
   * through the same scope check as everything else.
   */
  private async observeFrontWindow(front: FrontWindow): Promise<void> {
    // Reading a window is not permission to drive it. This grants the app for
    // observation and states the boundary; any action still passes the same
    // scope check as everything else.
    this.task.authorization = extendAuthorization(this.task.authorization, { apps: [front.name] })

    if (!this.canPlan()) return
    if (!this.deps.os.supports('window.inspect')) {
      this.planner.addNote(
        `The user was looking at ${front.name} ("${front.title}"). Kibu cannot read its contents because ` +
          `Accessibility permission is not granted. Say so rather than guessing what is in it.`
      )
      return
    }
    try {
      const snapshot = await this.deps.os.inspectWindow(front.pid, { maxNodes: 300 })
      this.context().observe({
        kind: 'window',
        summary: `The window you were in: ${snapshot.app.name} — "${snapshot.title}"`,
        data: { app: snapshot.app.name, pid: front.pid, title: snapshot.title },
        staleAfterMs: 30_000
      })
      this.planner.addNote(
        `The user was working in ${front.name} ("${snapshot.title}", pid ${front.pid}) when they asked. ` +
          `Call desktop_inspect_window with that pid to see its current contents before acting — ` +
          `this snapshot is already out of date.`
      )
    } catch (err) {
      this.planner.addNote(
        `The user was looking at ${front.name} ("${front.title}"), but Kibu could not read it: ` +
          `${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Attempts to complete the task with a workflow: deterministic code for the
   * mechanics, Jev for the judgment calls, no planning model.
   *
   * Returns false when no workflow applies or one declines part-way, in which
   * case the planner takes over. Workflows run their actions through
   * `executeTool`, so they inherit every scope check, verifier and undo record
   * the planner path has.
   */
  private async tryWorkflow(): Promise<boolean> {
    if (!this.deps.workflowsEnabled) return false

    const wfCtx = this.workflowContext()
    const route = (this.task as TaskState & { route?: string }).route ?? 'unclear'
    const match = await routeToWorkflow(this.task.request, this.deps.droppedPaths, wfCtx, route)
    if (!match) return false

    this.log('info', 'workflow', `running "${match.workflow.id}" — ${match.reason}`)
    this.setStatus('executing', 'Getting started')
    this.hooks.onPetState('working')

    let result
    try {
      result = await match.workflow.run(this.task.request, this.deps.droppedPaths, wfCtx)
    } catch (err) {
      if (err instanceof CancelledError) throw err
      this.log('warn', 'workflow', `${match.workflow.id} failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }

    if (result.handoffToPlanner) {
      this.log('info', 'workflow', `handing off to the planner: ${result.handoffToPlanner}`)
      // Tell the planner what the workflow already learned, so it does not
      // start from nothing.
      if (this.canPlan()) {
        this.planner.addNote(
          `A ${match.workflow.id} workflow was tried first and stopped because ${result.handoffToPlanner}. ` +
            `Continue from there.`
        )
        return false
      }
      // No planner available: report the workflow's own blocking question.
      this.completeFrom({ success: false, headline: result.headline, evidence: result.evidence, unresolved: result.handoffToPlanner })
      return true
    }

    this.completeFrom({
      success: result.success,
      headline: result.headline,
      evidence: result.evidence,
      ...(result.unresolved ? { unresolved: result.unresolved } : {})
    })
    return true
  }

  /**
   * What this Mac will not let Kibu do, and what the user would have to grant.
   * Permission gaps are a fact about the machine, not a tool failure, so the
   * planner is told before it plans rather than after it trips over one.
   */
  private missingCapabilities(): string | null {
    const gaps: string[] = []
    if (!this.deps.os.supports('window.inspect')) {
      gaps.push(
        'You cannot read or control other applications, and you cannot see what is on screen: macOS ' +
          'Accessibility permission has not been granted to Kibu. Any request that depends on seeing or ' +
          'driving another app must be answered by saying exactly that, and telling the user they can grant ' +
          'it under /tune. Do not attempt desktop tools, and never guess what a window contains.'
      )
    }
    if (!this.deps.os.supports('window.capture')) {
      gaps.push('You cannot take pictures of windows: Screen Recording permission has not been granted.')
    }
    return gaps.length ? gaps.join(' ') : null
  }

  /** True when a planning model could actually be constructed. */
  private canPlan(): boolean {
    return !!this.deps.createPlanner || !!this.deps.apiKey || !!process.env.ANTHROPIC_API_KEY
  }

  private workflowContext(): WorkflowContext {
    let step = 1000
    return {
      task: this.task,
      run: async (tool, input) => {
        await this.checkpoint()
        const outcome = await this.executeTool(tool, input, step++)
        return outcome.isError
          ? { ok: false, error: outcome.content }
          : { ok: true, result: outcome.result }
      },
      ask: (label, state, questions) => this.jev.ask(label, state, questions),
      askUser: (q) => this.ask(q),
      progress: (line) => {
        this.task.statusLine = line
        this.emit()
      },
      log: (level, message, data) => this.log(level, 'workflow', message, data),
      checkpoint: () => this.checkpoint(),
      understanding: () => this.read ?? fallbackUnderstanding(),
      authorizedRoots: () => [...this.task.authorization.writeRoots, ...this.task.authorization.readRoots]
    }
  }

  private availableTools(): ToolDefinition[] {
    const route = (this.task as TaskState & { route?: string }).route ?? 'unclear'
    return this.deps.registry.forTask(ROUTE_CAPABILITIES[route] ?? ROUTE_CAPABILITIES.unclear!)
  }

  private async loop(): Promise<void> {
    if (!this.canPlan()) {
      throw new Error(
        'This request needs the planning model, which has no API key configured. ' +
          'Add an Anthropic key in Settings, or ask for one of the tasks Kibu can do with Jev alone: ' +
          'organising a folder, finding a file, or renaming files consistently.'
      )
    }
    const tools = this.availableTools()
    const schema = this.deps.registry.toModelSchema(tools)
    let step = 0
    let nudgedForAnswer = false

    for (;;) {
      await this.checkpoint()
      step++
      this.enforceLimits(step)

      // Step 2: decide whether to keep going, re-look, or change approach.
      const verdict = await this.jev.assessProgress(this.task)
      if (verdict.action !== 'continue') {
        this.log('info', 'jev', `progress check: ${verdict.action} — ${verdict.reason}`)
        if (verdict.action === 'abort') throw new Error(verdict.reason)
        if (verdict.action === 'ask') {
          const answer = await this.ask({
            reason: 'blocked',
            prompt: `I'm stuck: ${verdict.reason}. How would you like me to proceed?`,
            allowFreeText: true,
            options: [
              { id: 'retry', label: 'Try again' },
              { id: 'stop', label: 'Stop here' }
            ]
          })
          if (answer.optionId === 'stop') {
            this.setStatus('cancelled', 'Stopped')
            this.task.summary = { headline: 'Stopped at your request', evidence: this.evidence, undoable: this.undoStack.length > 0 }
            return
          }
          this.planner.addNote(`The user was asked for help and said: ${answer.text ?? 'try again'}.`)
        } else {
          this.planner.addNote(
            verdict.action === 'reobserve'
              ? `Your last actions failed because what you were looking at changed. Observe again before acting.`
              : `The last few actions did not work. Change approach rather than repeating them.`
          )
        }
      }

      // Step 3: the model proposes actions.
      this.setStatus('planning', this.task.statusLine || 'Thinking')
      this.hooks.onPetState('thinking')
      const proposal = await this.planner.propose(schema)
      this.task.cost = addCost(this.task.cost, proposal)
      if (proposal.text) this.log('info', 'model', proposal.text)

      if (proposal.calls.length === 0) {
        // Prose with no action: either it is done, or it needs a nudge.
        if (proposal.stopReason === 'end_turn') {
          // A reply that narrates instead of answering ("Answering directly,
          // no actions needed") is sent back once for the actual answer.
          if (!nudgedForAnswer && isNarration(proposal.text)) {
            nudgedForAnswer = true
            this.planner.addNote('That describes what you are doing instead of answering. Reply with the answer itself, written to the user.')
            continue
          }
          this.finishFromText(proposal.text)
          return
        }
        this.planner.addNote('Continue by calling a tool, or call finish if the task is complete.')
        continue
      }

      // Step 4-6: validate, execute, verify each proposed action.
      const results: { callId: string; content: string; isError: boolean }[] = []
      let finished = false

      for (const call of proposal.calls) {
        await this.checkpoint()
        const outcome = await this.runCall(call, step)
        results.push({ callId: call.id, content: outcome.content, isError: outcome.isError })
        if (outcome.finished) {
          finished = true
          break
        }
      }

      this.planner.addToolResults(results)
      if (finished) return
    }
  }

  /** Validate → execute → verify one proposed tool call, for the planner. */
  private async runCall(
    call: { id: string; name: string; input: unknown },
    step: number
  ): Promise<{ content: string; isError: boolean; finished?: boolean }> {
    return this.executeTool(call.name, call.input, step)
  }

  /**
   * The single path every action takes, whether a model proposed it or a
   * workflow did. Sharing it is what guarantees a workflow cannot skip the
   * scope check, the verifier, or the undo record.
   */
  async executeTool(
    toolName: string,
    rawInput: unknown,
    step: number
  ): Promise<{ content: string; isError: boolean; finished?: boolean; result?: unknown }> {
    const call = { name: toolName, input: rawInput }
    const tool = this.deps.registry.get(call.name)
    if (!tool) {
      return { content: `No tool named "${call.name}" is available for this task.`, isError: true }
    }

    // Validate the shape locally. Model output is never trusted as-is.
    let input: unknown
    try {
      input = (tool.input as ZodType).parse(call.input)
    } catch (err) {
      return { content: `Invalid input for ${call.name}: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }

    // Validate scope. This gate is deterministic and cannot be talked past.
    const decision = checkScopes(this.task.authorization, tool.scopes(input))
    if (decision.refused) {
      this.log('warn', `tool:${call.name}`, `refused: ${decision.refused}`)
      return { content: `Refused: ${decision.refused}`, isError: true }
    }
    if (!decision.allowed) {
      const granted = await this.requestAuthorization(tool, decision.missing)
      if (!granted) {
        return {
          content: `The user declined to authorize this. Do not retry it; find another way or call finish explaining what is blocked.`,
          isError: true
        }
      }
    }

    const rejection = this.rejectedOperation(call.name, input)
    if (rejection) {
      this.log('warn', `tool:${call.name}`, `blocked: ${rejection}`)
      return { content: `Refused: ${rejection}`, isError: true }
    }

    // Opt-in belt and braces: confirm every world-changing action.
    if (this.deps.confirmEveryAction && tool.capability !== 'user.interact') {
      const go = await this.ask({
        reason: 'authorization',
        prompt: `Run ${call.name}?`,
        allowFreeText: false,
        preview: { title: `${call.name}`, note: JSON.stringify(input) },
        options: [
          { id: 'allow', label: 'Run it' },
          { id: 'skip', label: 'Skip' }
        ]
      })
      if (go.optionId !== 'allow') {
        return { content: `The user skipped ${call.name}. Do not retry it.`, isError: true }
      }
    }

    const record: ActionRecord = {
      id: randomUUID(),
      step,
      tool: call.name,
      input,
      startedAt: Date.now(),
      outcome: 'failure'
    }

    try {
      if (tool.precondition) await tool.precondition(input, this.context())
      this.setStatus('executing', this.task.statusLine)
      this.hooks.onPetState('working')

      const outcome = await tool.execute(input, this.context())
      record.finishedAt = Date.now()
      record.result = outcome.result
      record.outcome = outcome.uncertain ? 'uncertain' : 'success'

      if (outcome.undo?.length) {
        this.undoStack.push(...outcome.undo)
        record.undo = outcome.undo[0]
      }

      if (call.name === 'show_preview') this.recordPreviewVerdict(input, outcome.result)
      if (outcome.evidence?.length) this.evidence.push(...outcome.evidence)

      // Step 6: verify. A tool that says it worked is not yet proof.
      if (tool.verify) {
        this.setStatus('verifying', this.task.statusLine)
        const verification: VerificationResult = await tool.verify(input, outcome, this.context())
        record.verification = verification
        if (!verification.verified) {
          record.outcome = 'failure'
          this.task.actions.push(record)
          this.emit()
          return {
            content: `${call.name} reported success but verification failed: ${verification.detail}`,
            isError: true
          }
        }
      }

      this.task.actions.push(record)
      this.emit()

      if (call.name === 'finish') {
        this.completeFrom(outcome.result as {
          success: boolean
          headline: string
          evidence: Evidence[]
          unresolved?: string
        })
        return { content: 'Task closed.', isError: false, finished: true }
      }

      return {
        content: this.serializeResult(outcome.result, record.verification),
        isError: false,
        result: outcome.result
      }
    } catch (err) {
      record.finishedAt = Date.now()
      record.outcome = 'failure'
      record.error = err instanceof Error ? err.message : String(err)
      this.task.actions.push(record)
      this.emit()

      if (err instanceof CancelledError) throw err
      if (err instanceof UnsupportedCapabilityError) {
        return { content: `${err.message} Use a different approach.`, isError: true }
      }
      if (err instanceof StaleElementError) {
        return { content: `${err.message}`, isError: true }
      }
      this.log('warn', `tool:${call.name}`, record.error)
      return { content: `${call.name} failed: ${record.error}`, isError: true }
    }
  }

  private static opKey(from: string, to: string): string {
    return `${normalizePath(from)}\u0000${normalizePath(to)}`
  }

  /** Remembers the exact moves a user turned down. */
  private recordPreviewVerdict(input: unknown, result: unknown): void {
    const approved = (result as { approved?: boolean })?.approved
    if (approved !== false) return
    const ops = (input as { fileOps?: { from: string; to: string }[] })?.fileOps ?? []
    for (const op of ops) this.rejectedOps.add(TaskRunner.opKey(op.from, op.to))
    if (ops.length) {
      this.log('info', 'preview', `user declined ${ops.length} file operation(s); they are now blocked`)
    }
  }

  /** Returns a reason when this call was explicitly turned down earlier. */
  private rejectedOperation(toolName: string, input: unknown): string | null {
    if (!this.rejectedOps.size) return null
    if (!['files_move', 'files_rename', 'files_copy'].includes(toolName)) return null
    const { from, to } = (input as { from?: string; to?: string }) ?? {}
    if (!from || !to) return null
    if (!this.rejectedOps.has(TaskRunner.opKey(from, to))) return null
    return `the user declined moving ${basename(from)} to that destination in the preview. Do not retry it.`
  }

  /** Keeps tool results small enough to stay inside the context budget. */
  private serializeResult(result: unknown, verification?: VerificationResult): string {
    let text: string
    try {
      text = JSON.stringify(result)
    } catch {
      text = String(result)
    }
    const MAX = 12_000
    if (text.length > MAX) {
      text = `${text.slice(0, MAX)}\n…[truncated; ${text.length - MAX} more characters]`
    }
    return verification ? `${text}\n[verified: ${verification.detail}]` : text
  }

  /* ---------------------------------------------------------------- *
   * Authorization, questions, limits
   * ---------------------------------------------------------------- */

  private async requestAuthorization(tool: ToolDefinition, missing: ScopeRequest[]): Promise<boolean> {
    const description = describeMissing(missing)
    const answer = await this.ask({
      reason: 'authorization',
      prompt: `Kibu needs your OK to ${description}.`,
      allowFreeText: false,
      options: [
        { id: 'allow', label: 'Allow', detail: `Allows this for the rest of this task` },
        { id: 'deny', label: 'Not now' }
      ]
    })
    if (answer.optionId !== 'allow') return false
    this.task.authorization = extendAuthorization(this.task.authorization, grantFor(missing))
    this.log('info', 'authorization', `granted: ${description}`)
    return true
  }

  private async ask(q: Omit<UserQuestion, 'id'>): Promise<{ optionId: string | null; text?: string }> {
    const question: UserQuestion = { ...q, id: randomUUID() }
    this.task.question = question
    this.setStatus('awaiting_user', 'Waiting for you')
    this.hooks.onPetState('waiting')
    // Asking means we are not driving the screen; give it back to the user.
    this.dropDesktop()

    const answer = await new Promise<{ optionId: string | null; text?: string }>((resolve) => {
      this.pendingQuestion = { question, resolve }
      this.emit()
    })

    if (answer.text === '__cancelled__') throw new CancelledError()
    delete this.task.question
    this.setStatus('executing', this.task.statusLine)
    this.hooks.onPetState('working')
    return answer
  }

  private enforceLimits(step: number): void {
    const { limits } = this.task
    if (step > limits.maxSteps) {
      throw new LimitExceededError('steps', `Reached the ${limits.maxSteps}-step limit for one task without finishing.`)
    }
    const elapsed = Date.now() - this.startedAt
    if (elapsed > limits.maxWallClockMs) {
      throw new LimitExceededError('time', `Reached the ${Math.round(limits.maxWallClockMs / 60000)}-minute limit for one task.`)
    }
    const spend = this.task.cost.usd + this.jev.metrics.totalUsd
    if (spend > limits.maxUsd) {
      throw new LimitExceededError('cost', `Reached the $${limits.maxUsd.toFixed(2)} spending limit for one task.`)
    }
    // A warning shot lets the model wrap up cleanly rather than being cut off.
    if (step === Math.floor(limits.maxSteps * 0.75)) {
      this.planner.addNote(`You have about ${limits.maxSteps - step} steps left. Start wrapping up.`)
    }
  }

  private async checkpoint(): Promise<void> {
    if (this.cancelled) throw new CancelledError()
    if (this.paused) {
      this.emit()
      await this.pauseGate
    }
    if (this.cancelled) throw new CancelledError()
  }

  /* ---------------------------------------------------------------- *
   * Completion
   * ---------------------------------------------------------------- */

  private completeFrom(result: { success: boolean; headline: string; evidence: Evidence[]; unresolved?: string }): void {
    const evidence = [...this.evidence, ...(result.evidence ?? [])]
    // De-duplicate: the same folder often arrives from several actions.
    const seen = new Set<string>()
    const unique = evidence.filter((e) => {
      const key = `${e.kind}:${e.value}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    this.task.summary = {
      headline: result.headline,
      evidence: unique,
      undoable: this.undoStack.length > 0
    }
    if (result.success) {
      this.setStatus('succeeded', 'Done')
      this.hooks.onPetState('finished')
    } else {
      this.task.error = result.unresolved ?? 'the task could not be completed'
      this.setStatus('failed', 'Could not finish')
      this.hooks.onPetState('failed')
    }
  }

  /** The model ended its turn without calling finish; treat prose as the result. */
  private finishFromText(text: string): void {
    this.task.summary = {
      // A conversational answer can be a few paragraphs; only runaway text is clipped.
      headline: text ? text.slice(0, 4000) : 'Finished without a summary',
      evidence: this.evidence,
      undoable: this.undoStack.length > 0
    }
    this.setStatus('succeeded', 'Done')
    this.hooks.onPetState('finished')
    this.log('warn', 'loop', 'task ended without calling finish; used the final message as the summary')
  }

  get undoEntries(): UndoEntry[] {
    return this.undoStack
  }

  private isFinished(): boolean {
    return ['succeeded', 'failed', 'cancelled'].includes(this.task.status)
  }

  /* ---------------------------------------------------------------- *
   * Plumbing
   * ---------------------------------------------------------------- */

  private context(): ToolContext {
    return {
      task: this.task,
      os: this.deps.os,
      browser: this.deps.browser,
      log: (level, message, data) => this.log(level, 'tool', message, data),
      progress: (line) => {
        this.task.statusLine = line
        this.emit()
      },
      observe: (o) => {
        const observation: Observation = { ...o, id: randomUUID(), observedAt: Date.now() }
        this.task.observations.push(observation)
        // Old observations are noise and a privacy liability; keep a window.
        if (this.task.observations.length > 30) this.task.observations.shift()
        this.emit()
        return observation
      },
      ask: (q) => this.ask(q),
      checkpoint: () => this.checkpoint(),
      claimDesktop: async (reason) => {
        await this.hooks.claimDesktop(this.task.id, reason)
        this.holdsDesktop = true
      },
      releaseDesktop: () => this.dropDesktop()
    }
  }

  private dropDesktop(): void {
    if (!this.holdsDesktop) return
    this.holdsDesktop = false
    this.hooks.releaseDesktop(this.task.id)
  }

  private setStatus(status: TaskState['status'], statusLine: string): void {
    this.task.status = status
    this.task.statusLine = statusLine
    this.task.updatedAt = Date.now()
    this.emit()
  }

  private log(level: LogEntry['level'], source: string, message: string, data?: unknown): void {
    this.hooks.onLog({ taskId: this.task.id, at: Date.now(), level, source, message, data })
  }

  private emit(): void {
    this.task.updatedAt = Date.now()
    this.hooks.onUpdate(this.task)
  }
}
