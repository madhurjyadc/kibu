import { hasLocalSearchIntent } from '../search-language.js'
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

  /**
   * Whether the browser Kibu opened should be closed now the task is done.
   *
   * Both answers are defined here, in code; Jev only picks between them, and
   * a missing or unsure answer leaves the window open — the outcome that
   * cannot lose anything.
   */
  async shouldCloseBrowser(request: string): Promise<boolean> {
    const answers = await this.ask(
      'close_browser',
      { userRequest: request },
      {
        close: noul(
          'The assistant opened a browser to do this and has now finished. Was the browser only a means to ' +
            'an end, so it should be closed and tidied away?',
          {
            true: 'The user wanted an answer or an action, not a browser window to look at.',
            false: 'The user wanted something left open on screen for them to use or read.'
          }
        )
      }
    )
    if (!answers) return true // No Jev: the plain default is to tidy up.
    return answers.close.noul > 0.6
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
    // Naming a site, or a domain, is as plain a web signal as saying "website".
    // This list will never be complete — that is exactly why an unsure answer
    // goes to Jev rather than to a bigger list.
    const site =
      /\b(youtube|netflix|gmail|google|twitter|x\.com|reddit|amazon|instagram|facebook|spotify|wikipedia|github|linkedin|maps|chatgpt)\b/.test(r) ||
      // Any domain-shaped token, minus the ones that are really filenames.
      // Listing top-level domains is a losing game: bunkr.cr is as real as
      // youtube.com, so the rule is "looks like a host, is not a file".
      (/\b[a-z0-9][a-z0-9-]{1,}\.[a-z]{2,6}\b/.test(r) &&
        !/\.(pdf|png|jpe?g|gif|mp4|mov|mp3|docx?|xlsx?|pptx?|txt|csv|zip|dmg|heic|webp|md|json|ts|js|py)\b/.test(r))
    const browser =
      site ||
      /\b(website|url|http|browser|online|web form|log ?in to|download from|fill in the form|watch|stream|search the web|google it)\b/.test(r)
    const files = hasLocalSearchIntent(r) ||
      /\b(file|files|folder|desktop|downloads|downloaded|organi[sz]e|rename|sort|move|pdf|screenshot|document|invoice|spreadsheet)\b/.test(r)
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
   * Getting the planner ready
   * ---------------------------------------------------------------- */

  /**
   * Everything the planning model's first step would otherwise spend a round
   * trip on, decided in one Jev call:
   *
   *   - which tool families the request needs, so the planner is shown a
   *     short menu instead of every tool (a shorter prompt is a faster step);
   *   - which parts of "this" to fetch up front — selection, browser tab,
   *     Finder selection, clipboard — so the planner starts with them rather
   *     than asking for them;
   *   - whether the job is small enough for the quick model.
   *
   * None of it grants anything. Narrowing the menu only hides tools, and the
   * runner widens it again, and moves to the full model, the moment the
   * work stops going well. Without Jev the same answers come from keywords.
   */
  async planSetup(request: string, route: string, hasDroppedPaths: boolean): Promise<PlanSetup> {
    const local = localPlanSetup(request, route, hasDroppedPaths)
    if (!this.client) {
      this.record('plan_setup', false, 0, 0, 0, describeSetup(local), 1)
      return local
    }
    const started = Date.now()
    const family = (question: string) => noul(question, { true: 'Yes, this is needed.', false: 'No.' })
    try {
      const { answers, usage } = await this.client.systemOne({
        state: { request, filesDroppedOntoAssistant: hasDroppedPaths, today: new Date().toDateString() },
        questions: {
          files: family('Does this involve files or folders on the computer?'),
          desktop: family("Does this need clicking and typing inside an app's window, for an app with no other way in?"),
          browser: family('Does this need a web browser to visit a site, search the web, fill a form or download something?'),
          calendar: family('Does this involve the calendar: events, meetings, schedule, free time?'),
          reminders: family('Does this involve reminders or a to-do list?'),
          notes: family('Does this involve the Notes app: writing, finding or reading a note?'),
          mail: family('Does this involve writing an email?'),
          shortcuts: family("Does this ask to run one of the user's Shortcuts?"),
          system: family('Does this involve a system setting (dark mode, volume) or opening or quitting an app?'),
          selection: family('Does "this", "it" or "that" refer to text the user has selected?'),
          tab: family('Does the request refer to the web page or site the user has open?'),
          finder: family('Does it refer to files the user has selected in Finder?'),
          clipboard: family('Does the user mention something they copied, or the clipboard?'),
          ownBrowser: family("Is this personal browsing best done in the user's own signed-in browser — watching, listening, their feed, their accounts, their inbox — rather than an unattended job like downloading or filling in a form?"),
          start: choice('Where would a person start this on the web?', {
            feed: 'Their personalised home feed or recommendations, because they want something good rather than one specific thing.',
            search: 'A search, because they named a specific thing, topic or question.',
            direct: 'A specific page or site they named.',
            none: 'This is not a web task.'
          }),
          effort: choice('How much work is this?', {
            quick: 'One small job in one place: add an event, answer from one page, change a setting.',
            involved: 'Several steps across apps or sites, working something out, or writing something substantial.'
          })
        }
      })
      const yes = (a: { noul?: number } | undefined, fallback: boolean): boolean =>
        typeof a?.noul === 'number' ? a.noul > 0.5 : fallback
      const families = FAMILY_KEYS.filter((k) => yes(answers[k] as { noul?: number }, local.families.includes(k)))
      const setup: PlanSetup = {
        // A family local keywords are sure of stays even if Jev disagrees:
        // hiding a tool the request plainly names can only cost a replan.
        families: [...new Set([...families, ...local.families])],
        context: {
          selection: yes(answers.selection as { noul?: number }, local.context.selection),
          tab: yes(answers.tab as { noul?: number }, local.context.tab),
          finder: yes(answers.finder as { noul?: number }, local.context.finder),
          // The clipboard can hold anything, passwords included: only read it
          // when the words actually point at it.
          clipboard: local.context.clipboard && yes(answers.clipboard as { noul?: number }, true)
        },
        quick: (answers.effort as { choice?: string } | undefined)?.choice === 'quick',
        ownBrowser: yes(answers.ownBrowser as { noul?: number }, local.ownBrowser),
        start: (((answers.start as { choice?: string } | undefined)?.choice) as PlanSetup['start'] | undefined) ?? local.start,
        source: 'jev'
      }
      this.record('plan_setup', true, Date.now() - started, jevCost(usage.input_tokens), usage.input_tokens, describeSetup(setup), 1)
      return setup
    } catch {
      this.record('plan_setup', true, Date.now() - started, 0, 0, `${describeSetup(local)} (fallback)`, 0)
      return local
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

export const FAMILY_KEYS = ['files', 'desktop', 'browser', 'calendar', 'reminders', 'notes', 'mail', 'shortcuts', 'system'] as const
export type Family = (typeof FAMILY_KEYS)[number]

export interface PlanSetup {
  families: Family[]
  context: { selection: boolean; tab: boolean; finder: boolean; clipboard: boolean }
  /** The job is small enough for the quick model. */
  quick: boolean
  /** Personal browsing happens in the user's own browser, where they are signed in. */
  ownBrowser: boolean
  /** Where a person would start on the web: their feed, a search, a named page. */
  start: 'feed' | 'search' | 'direct' | 'none'
  source: 'local' | 'jev'
}

const FAMILY_WORDS: Record<Family, RegExp> = {
  files: /\b(files?|folders?|downloads?|desktop|documents?|pdfs?|screenshots?|images?|photos?|rename|organi[sz]e|tidy)\b/i,
  desktop: /\b(click|window|menu|button|type into|in the app)\b/i,
  browser: /\b(website|site|web|online|google|search for|look up|download from|https?:\/\/|\w+\.(com|org|io|net|dev|ai|in|co))\b/i,
  calendar: /\b(calendar|meeting|event|schedule|appointment|agenda|free (?:at|hour|time|slot|between)|busy|call with|availability)\b/i,
  reminders: /\b(remind|reminders?|to-?do|todo)\b/i,
  notes: /\b(notes?|jot)\b/i,
  mail: /\b(e-?mail|mail|reply to|draft)\b/i,
  shortcuts: /\bshortcuts?\b/i,
  system: /\b(dark mode|light mode|volume|mute|unmute|quit|launch|open (?:the )?app)\b/i
}

/** The keyword reading of the same questions, used without Jev and as a floor with it. */
export function localPlanSetup(request: string, route: string, hasDroppedPaths: boolean): PlanSetup {
  const families = FAMILY_KEYS.filter((k) => FAMILY_WORDS[k].test(request))
  if (hasDroppedPaths && !families.includes('files')) families.push('files')
  if (families.length === 0) {
    // Nothing named: fall back to what the route implies.
    if (route === 'browser') families.push('browser')
    else if (route === 'desktop') families.push('desktop', 'system')
    else if (route === 'files') families.push('files')
  }
  const deictic = /\b(this|that|it|these|those|here)\b/i.test(request)
  return {
    families,
    context: {
      selection: deictic && !hasDroppedPaths,
      tab:
        /\b(page|tab|site|article|link|video|post|thread)\b/i.test(request) &&
        (deictic || /\b(have open|had open|got open|currently|current|viewing|reading|watching|looking at|i'?m on|on screen)\b/i.test(request)),
      finder: deictic && /\b(files?|folders?|selected)\b/i.test(request) && !hasDroppedPaths,
      clipboard: /\b(clipboard|copied|paste)\b/i.test(request)
    },
    quick: request.trim().split(/\s+/).length <= 14 && !/\b(and then|then|after that|every|each|all of)\b/i.test(request),
    ownBrowser:
      /\b(watch|play|listen|my (?:feed|home ?feed|inbox|account|playlist|subscriptions|timeline|profile)|youtube|netflix|spotify|twitter|x\.com|instagram|reddit|gmail|linkedin|in (?:my )?(?:browser|chrome|safari))\b/i.test(request) &&
      !/\b(download|fill (?:in|out)|sign ?up|scrape)\b/i.test(request),
    start: !families.includes('browser') && !/\b(youtube|netflix|spotify|website|site|web|online|watch|video)\b/i.test(request)
      ? 'none'
      : /\bhttps?:\/\/|\b[a-z0-9-]+\.(?:com|org|io|net|dev|ai|in|co)\b/i.test(request) && !/\b(something|anything|good|recommend)\b/i.test(request)
        ? 'direct'
        : /\b(something|anything|a good|good|recommend|random|to watch|to listen|while)\b/i.test(request)
          ? 'feed'
          : 'search',
    source: 'local'
  }
}

function describeSetup(s: PlanSetup): string {
  const ctx = Object.entries(s.context).filter(([, v]) => v).map(([k]) => k)
  const web = s.start !== 'none' ? `, web: ${s.ownBrowser ? 'your browser' : "Kibu's browser"} from ${s.start}` : ''
  return `${s.families.join('+') || 'everything'}${ctx.length ? `, fetch ${ctx.join('+')}` : ''}${web}, ${s.quick ? 'quick' : 'full'} model`
}

/** Summary line for the task history, so Jev's cost and effect stay visible. */
export function summarizeJev(m: JevMetrics): string {
  const modelCalls = m.calls.filter((c) => c.usedModel).length
  return (
    `${m.calls.length} decisions (${modelCalls} via Jev, ${m.overrides} changed the local verdict), ` +
    `${m.totalLatencyMs}ms, $${m.totalUsd.toFixed(5)}`
  )
}
