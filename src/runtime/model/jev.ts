import {
  TypeSafeClient,
  choice,
  noul,
  score,
  type EntryType,
  type Fetch,
  type Questions,
  type SystemOneResult
} from '@typesafe-ai/sdk'
import type { TaskState } from '../../shared/types.js'

/**
 * Jev — TypeSafe AI's System One model, used for narrow structured judgments.
 *
 * Jev is not a text model. You hand it state plus a set of declared typed
 * questions, and it answers all of them in one round trip with probabilities.
 * That shape dictates how it is used here:
 *
 *   - It picks between alternatives we declared. It cannot invent a folder
 *     name, so naming groups stays with the planning model and Jev only
 *     assigns files to groups that already exist.
 *   - It never authorizes anything and never decides a task succeeded. Those
 *     are deterministic checks elsewhere, and a probability is not a
 *     permission.
 *   - Where local code can decide correctly, local code decides. Jev is
 *     consulted only for the genuinely ambiguous middle.
 *
 * One safety property is enforced rather than hoped for: `assessProgress` lets
 * Jev make the loop *more* cautious but never less. See `atLeastAsCautious`.
 */

export interface JevCallRecord {
  decision: string
  usedModel: boolean
  latencyMs: number
  usd: number
  inputTokens: number
  outcome: string
  confidence: number
}

export interface JevMetrics {
  calls: JevCallRecord[]
  totalUsd: number
  totalLatencyMs: number
  /** Times a Jev answer changed what local rules would have done on their own. */
  overrides: number
}

export type Route = 'files' | 'desktop' | 'browser' | 'mixed' | 'unclear'

export interface RouteDecision {
  route: Route
  confidence: number
  reason: string
  needsClarification: boolean
}

export type ProgressAction = 'continue' | 'replan' | 'reobserve' | 'ask' | 'abort'

export interface ProgressVerdict {
  action: ProgressAction
  reason: string
  /** True when local rules alone produced this verdict. */
  deterministic: boolean
}

/** Jev pricing: $0.042 per million input tokens, output unmetered. */
const JEV_INPUT_PER_MTOK = 0.042

function jevCost(inputTokens: number): number {
  return (inputTokens * JEV_INPUT_PER_MTOK) / 1_000_000
}

/** Ordered least to most cautious. Used to stop Jev relaxing a local verdict. */
const CAUTION_ORDER: ProgressAction[] = ['continue', 'reobserve', 'replan', 'ask', 'abort']

function atLeastAsCautious(local: ProgressAction, proposed: ProgressAction): ProgressAction {
  return CAUTION_ORDER.indexOf(proposed) > CAUTION_ORDER.indexOf(local) ? proposed : local
}

export { choice, noul, score }

export class Jev {
  private client: TypeSafeClient | null = null
  readonly metrics: JevMetrics = { calls: [], totalUsd: 0, totalLatencyMs: 0, overrides: 0 }

  constructor(
    apiKey: string | null,
    private readonly enabled: boolean,
    model = 'jev-latest',
    /** Transport override. Used to exercise Jev's behaviour without a network. */
    fetchImpl?: Fetch
  ) {
    if (!enabled) return
    try {
      // The constructor throws when no key is configured; falling back to
      // local rules is correct, and must not take the task down.
      this.client = new TypeSafeClient({
        ...(apiKey ? { apiKey } : {}),
        defaultModel: model,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        // Jev answers in ~100ms; a slow call means something is wrong and the
        // loop is better off falling back to local rules than waiting.
        timeout: 4000,
        logLevel: 'off'
      })
    } catch {
      this.client = null
    }
  }

  get available(): boolean {
    return this.client !== null
  }

  /**
   * Pose arbitrary declared questions about some state.
   *
   * This is the general entry point workflows use. It returns `null` rather
   * than throwing when Jev is unavailable or errors, because every caller must
   * have a path that works without it.
   */
  async ask<const Q extends Questions>(
    label: string,
    state: EntryType,
    questions: Q
  ): Promise<SystemOneResult<Q>['answers'] | null> {
    if (!this.client || Object.keys(questions).length === 0) return null
    const started = Date.now()
    try {
      const { answers, usage } = await this.client.systemOne({ state, questions })
      this.record(
        label,
        true,
        Date.now() - started,
        jevCost(usage.input_tokens),
        usage.input_tokens,
        `${Object.keys(questions).length} answers`,
        1
      )
      return answers
    } catch {
      this.record(label, true, Date.now() - started, 0, 0, 'failed', 0)
      return null
    }
  }

  /* ---------------------------------------------------------------- *
   * Routing
   * ---------------------------------------------------------------- */

  /**
   * Which family of tools this request needs, used to scope the tool surface
   * offered to the planner. Local keyword rules answer the easy cases; Jev is
   * asked only when they are unsure.
   */
  async routeRequest(request: string, hasDroppedPaths: boolean): Promise<RouteDecision> {
    const local = this.routeLocally(request, hasDroppedPaths)
    if (!this.client || local.confidence >= 0.85) {
      this.record('route', false, 0, 0, 0, local.route, local.confidence)
      return local
    }

    const started = Date.now()
    try {
      const { answers, usage } = await this.client.systemOne({
        state: {
          request,
          filesDroppedOntoAssistant: hasDroppedPaths
        },
        questions: {
          route: choice('Which kind of work does this request need?', {
            files: 'Organising, finding, renaming or reading files already on this computer.',
            desktop: "Driving a native Mac application's windows, menus and controls.",
            browser: 'Visiting a website, filling in a web form, or downloading something.',
            mixed: 'Genuinely needs more than one of the above to complete.',
            unclear: 'There is not enough information to tell what is being asked.'
          }),
          needsClarification: noul('Is this request too vague to act on without asking the user what they mean?', {
            true: 'A reasonable assistant would have to ask a question before starting.',
            false: 'There is a clear, sensible first step.'
          })
        }
      })

      const latency = Date.now() - started
      const decision: RouteDecision = {
        route: answers.route.choice,
        confidence: answers.route.confidence,
        reason: `Jev chose ${answers.route.choice} (${(answers.route.confidence * 100).toFixed(0)}% confident)`,
        // Above 0.5 is a yes for a noul probability.
        needsClarification: answers.needsClarification.noul > 0.5
      }
      if (decision.route !== local.route) this.metrics.overrides++
      this.record('route', true, latency, jevCost(usage.input_tokens), usage.input_tokens, decision.route, decision.confidence)
      return decision
    } catch {
      // Jev being unavailable must never fail a task.
      this.record('route', true, Date.now() - started, 0, 0, `${local.route} (fallback)`, local.confidence)
      return local
    }
  }

  /** Keyword routing. Confident enough often enough to skip the network call. */
  private routeLocally(request: string, hasDroppedPaths: boolean): RouteDecision {
    const r = request.toLowerCase()
    const browser = /\b(website|url|http|browser|online|web form|log ?in to|download from|fill in the form)\b/.test(r)
    const files = /\b(file|files|folder|desktop|downloads|organi[sz]e|rename|sort|move|pdf|screenshot)\b/.test(r)
    const desktop = /\b(app|application|window|finder|preview|notes|mail|keynote|pages|numbers|this window)\b/.test(r)
    const signals = [browser, files, desktop].filter(Boolean).length

    if (signals === 0) {
      return {
        route: hasDroppedPaths ? 'files' : 'unclear',
        confidence: hasDroppedPaths ? 0.9 : 0.3,
        reason: hasDroppedPaths ? 'files were dropped on the pet' : 'no strong signal in the wording',
        // "Tidy this up" is only vague in the abstract. Dropping files on the
        // pet says which "this" is meant, so there is nothing to ask about.
        needsClarification: !hasDroppedPaths && request.trim().split(/\s+/).length < 4
      }
    }
    if (signals > 1) return { route: 'mixed', confidence: 0.6, reason: 'several signals present', needsClarification: false }
    if (browser) return { route: 'browser', confidence: 0.85, reason: 'mentions the web', needsClarification: false }
    if (desktop) return { route: 'desktop', confidence: 0.8, reason: 'mentions an app or window', needsClarification: false }
    return {
      route: 'files',
      confidence: hasDroppedPaths ? 0.95 : 0.85,
      reason: hasDroppedPaths ? 'files were dropped on the pet' : 'mentions files or folders',
      needsClarification: false
    }
  }

  /* ---------------------------------------------------------------- *
   * Progress
   * ---------------------------------------------------------------- */

  /**
   * Local rules only. Same history in, same verdict out, every time — a
   * failure budget that a probability could talk its way past would not be a
   * budget. `assessProgress` layers Jev on top of this without replacing it.
   */
  assessProgressLocally(task: TaskState): ProgressVerdict {
    const actions = task.actions
    if (actions.length === 0) return { action: 'continue', reason: 'no actions yet', deterministic: true }

    let consecutiveFailures = 0
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i]!.outcome === 'failure') consecutiveFailures++
      else break
    }
    if (consecutiveFailures >= task.limits.maxConsecutiveFailures) {
      return { action: 'ask', reason: `${consecutiveFailures} actions failed in a row`, deterministic: true }
    }

    const recent = actions.slice(-4)
    if (recent.length === 4 && recent.every((a) => a.outcome === 'failure')) {
      return { action: 'replan', reason: 'the last four actions all failed', deterministic: true }
    }

    const lastTwo = actions.slice(-2)
    if (
      lastTwo.length === 2 &&
      lastTwo.every((a) => a.outcome === 'failure') &&
      lastTwo[0]!.tool === lastTwo[1]!.tool &&
      lastTwo[0]!.error === lastTwo[1]!.error
    ) {
      const stale = /re-?inspect|no longer|changed|stale/i.test(lastTwo[1]!.error ?? '')
      return {
        action: stale ? 'reobserve' : 'replan',
        reason: `${lastTwo[1]!.tool} failed twice with the same error`,
        deterministic: true
      }
    }

    if (actions.length >= 6) {
      const fingerprints = actions.slice(-6).map((a) => `${a.tool}:${JSON.stringify(a.input)}`)
      if (new Set(fingerprints).size === 1) {
        return { action: 'replan', reason: 'the same call has repeated six times', deterministic: true }
      }
    }

    return { action: 'continue', reason: 'progressing', deterministic: true }
  }

  /**
   * The verdict the loop uses. Local rules decide first. Jev is consulted only
   * for the ambiguous middle — no rule fired, but the recent history is untidy
   * — and its answer is clamped so it can only increase caution.
   */
  async assessProgress(task: TaskState): Promise<ProgressVerdict> {
    const local = this.assessProgressLocally(task)
    if (!this.client || local.action !== 'continue' || !this.looksUntidy(task)) {
      return local
    }

    const started = Date.now()
    try {
      const { answers, usage } = await this.client.systemOne({
        state: {
          goal: task.request,
          recentSteps: task.actions.slice(-8).map((a) => ({
            tool: a.tool,
            outcome: a.outcome,
            error: a.error ?? null,
            verified: a.verification?.verified ?? null
          }))
        },
        questions: {
          nextMove: choice('What should the assistant do next?', {
            continue: 'The work is progressing; carry on with the current plan.',
            reobserve: 'What it is acting on has probably changed; look again before acting.',
            replan: 'The current approach is not working; a different approach is needed.',
            ask: 'It is stuck in a way the user needs to resolve.'
          }),
          stuck: noul('Is this task repeating itself without getting closer to the goal?')
        }
      })

      const latency = Date.now() - started
      const proposed = answers.nextMove.choice as ProgressAction
      // Jev may tighten the verdict, never loosen it.
      const action = atLeastAsCautious(local.action, proposed)
      if (action !== local.action) this.metrics.overrides++

      this.record('progress', true, latency, jevCost(usage.input_tokens), usage.input_tokens, action, answers.nextMove.confidence)

      if (action === local.action) return local
      return {
        action,
        reason: `Jev: ${proposed} (${(answers.nextMove.confidence * 100).toFixed(0)}% confident, stuck ${(answers.stuck.noul * 100).toFixed(0)}%)`,
        deterministic: false
      }
    } catch {
      return local
    }
  }

  /** Cheap precondition: only spend a Jev call when the history looks messy. */
  private looksUntidy(task: TaskState): boolean {
    const recent = task.actions.slice(-6)
    if (recent.length < 4) return false
    return recent.some((a) => a.outcome === 'failure' || a.outcome === 'uncertain')
  }

  /* ---------------------------------------------------------------- *
   * File grouping
   * ---------------------------------------------------------------- */

  /**
   * Assigns files to groups that already exist.
   *
   * Jev chooses between declared labels, so it cannot name the groups — the
   * planning model proposes those, and Jev does the bulk assignment in one
   * round trip instead of one model call per file. The result is a proposal
   * that still goes to the user as a preview before anything moves.
   */
  async assignFilesToGroups(
    files: { name: string; ext: string; modifiedAt: number }[],
    groups: { name: string; description: string }[]
  ): Promise<{ assignments: Record<string, string>; unsorted: string[] } | null> {
    if (!this.client || files.length === 0 || groups.length === 0) return null

    const criteria: Record<string, string> = { unsorted: 'Does not belong in any of the other groups.' }
    for (const g of groups) criteria[g.name] = g.description

    const assignments: Record<string, string> = {}
    const unsorted: string[] = []
    const started = Date.now()
    let inputTokens = 0

    // Jev answers many questions in one call, so files are batched rather than
    // asked one at a time.
    const BATCH = 40
    try {
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH)
        const questions: Questions = {}
        batch.forEach((_f, idx) => {
          questions[`f${idx}`] = choice(`Which group does file ${idx} belong in?`, criteria)
        })

        const { answers, usage } = await this.client.systemOne({
          state: {
            task: 'Assign each listed file to the group it belongs in.',
            files: batch.map((f, idx) => ({
              index: idx,
              name: f.name,
              extension: f.ext,
              modified: new Date(f.modifiedAt).toISOString().slice(0, 10)
            }))
          },
          questions
        })

        inputTokens += usage.input_tokens
        batch.forEach((f, idx) => {
          const answer = answers[`f${idx}`]
          if (!answer || answer.type !== 'choice') {
            unsorted.push(f.name)
            return
          }
          if (answer.choice === 'unsorted') unsorted.push(f.name)
          else assignments[f.name] = answer.choice
        })
      }

      this.record(
        'assign_files',
        true,
        Date.now() - started,
        jevCost(inputTokens),
        inputTokens,
        `${Object.keys(assignments).length} assigned, ${unsorted.length} unsorted`,
        1
      )
      return { assignments, unsorted }
    } catch {
      this.record('assign_files', true, Date.now() - started, jevCost(inputTokens), inputTokens, 'failed', 0)
      return null
    }
  }

  private record(
    decision: string,
    usedModel: boolean,
    latencyMs: number,
    usd: number,
    inputTokens: number,
    outcome: string,
    confidence: number
  ): void {
    this.metrics.calls.push({ decision, usedModel, latencyMs, usd, inputTokens, outcome, confidence })
    this.metrics.totalUsd += usd
    this.metrics.totalLatencyMs += latencyMs
  }
}

/** Summary line for the task history, so Jev's cost and effect stay visible. */
export function summarizeJev(m: JevMetrics): string {
  const modelCalls = m.calls.filter((c) => c.usedModel).length
  return (
    `${m.calls.length} decisions (${modelCalls} via Jev, ${m.overrides} changed the local verdict), ` +
    `${m.totalLatencyMs}ms, $${m.totalUsd.toFixed(5)}`
  )
}
