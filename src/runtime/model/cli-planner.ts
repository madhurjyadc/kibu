import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_PROMPT, type PlannerLike, type PlannerProposal, type ToolResultInput } from './planner.js'
import type { TaskState } from '../../shared/types.js'

/**
 * Planning through a coding app already installed on this Mac — Claude Code,
 * Codex or OpenCode — using the login that is already there.
 *
 * Every one of them is an agent with tools of its own. Here it is only asked
 * to answer: it proposes Kibu's tool calls as JSON, and Kibu's own loop still
 * does every check, execution, verification and undo. What differs between
 * the apps is only how a message gets to them and back, which is all a
 * subclass supplies.
 *
 * Scope, stated plainly: this is for running Kibu on your own machine with
 * your own login. A distributed build must ship the API path instead.
 */

export interface CliReply {
  result: string
  inputTokens: number
  outputTokens: number
}

const REPLY_CONTRACT = `Reply with ONE JSON object and nothing else — no prose around it, no markdown fence:

{"text": "<see below>",
 "calls": [{"name": "<tool name>", "input": { ... }}]}

"text" is shown to the user. When the request is a question or conversation that needs no tool, put your complete answer in "text", written to the user in plain words, and send no calls. Never describe what you are doing instead of answering ("Answering directly", "No actions needed"). When you are calling tools, "text" may be a short line about the step, or empty.

Propose one step at a time unless several calls are genuinely independent. Use only the tools listed above, with exactly those input fields. If the task is finished, call finish. If you need the user, call ask_user.`

/** Said to apps whose own tools cannot be switched off: they answer, Kibu acts. */
const ANSWER_ONLY = `You are only planning. Do not run commands, read files or browse yourself, even if you are able to: Kibu runs every tool listed here and sends you the results.`

/** How much of the transcript is replayed to a model that has not seen it. */
const REPLAY_BUDGET = 60_000

export abstract class CliPlanner implements PlannerLike {
  /** What the app is called, in errors the user reads. */
  protected abstract readonly label: string
  /** Kibu's instructions go in the first message, for apps with no system prompt option. */
  protected readonly inlineInstructions: boolean = true
  private seed_: string[] = []
  private pending: string[] = []
  /** Tools already described in this conversation, so later turns send only new ones. */
  private described = new Set<string>()
  /**
   * Everything said so far in this task, Kibu's messages and the replies.
   * Kibu keeps it rather than the app, so no app has to save the
   * conversation to disk, and a new process or model picks up where the
   * last one left off.
   */
  private transcript: string[] = []

  /** Sends one message and waits for the reply. */
  protected abstract exchange(message: string): Promise<CliReply>

  /** Whether the next message reaches a process that has already seen this conversation. */
  protected abstract holdsConversation(): boolean

  seed(task: TaskState, droppedPaths: string[]): void {
    const context: string[] = [`<user_request>\n${task.request}\n</user_request>`]
    if (droppedPaths.length) {
      context.push(
        `The user dropped these onto Kibu, so they are part of the request:\n${droppedPaths.map((p) => `- ${p}`).join('\n')}`
      )
    }
    context.push(
      `Already authorized for this task:\n` +
        `- readable folders: ${task.authorization.readRoots.join(', ') || 'none yet'}\n` +
        `- writable folders: ${task.authorization.writeRoots.join(', ') || 'none yet'}\n` +
        `- apps: ${task.authorization.apps.join(', ') || 'none yet'}\n` +
        `Anything outside this will pause and ask the user, so plan inside it where you can.`
    )
    context.push(`Today is ${new Date().toDateString()}. The user's home folder is ${process.env.HOME}.`)
    this.seed_ = context
  }

  addToolResults(results: ToolResultInput[]): void {
    for (const r of results) {
      this.pending.push(
        `<tool_result call="${r.callId}"${r.isError ? ' error="true"' : ''}>\n${clip(r.content)}\n</tool_result>`
      )
    }
  }

  addNote(note: string): void {
    this.pending.push(`<system_note>${note}</system_note>`)
  }

  async propose(tools: { name: string; description: string; input_schema: object }[]): Promise<PlannerProposal> {
    const first = this.transcript.length === 0
    const parts: string[] = []
    const fresh = tools.filter((t) => !this.described.has(t.name))
    for (const t of fresh) this.described.add(t.name)
    if (first) {
      if (this.inlineInstructions) parts.push(`<kibu_instructions>\n${SYSTEM_PROMPT}\n\n${ANSWER_ONLY}\n</kibu_instructions>`)
      parts.push(...this.seed_)
      parts.push(`Tools you may call:\n${tools.map(describe).join('\n\n')}`)
    } else {
      // The menu can grow mid-task when the first approach stalls.
      if (fresh.length) parts.push(`More tools are now available:\n${fresh.map(describe).join('\n\n')}`)
      if (this.pending.length === 0 && !fresh.length) parts.push('Continue.')
    }
    parts.push(...this.pending)
    this.pending = []
    parts.push(REPLY_CONTRACT)

    let raw = await this.ask(parts.join('\n\n'))
    let parsed = parseProposal(raw.result)
    if (!parsed) {
      // One nudge before giving up. Models occasionally wrap the object in
      // prose despite the contract.
      const retry = await this.ask('That was not parseable. Send the JSON object only, nothing else.')
      raw = { ...retry, inputTokens: raw.inputTokens + retry.inputTokens, outputTokens: raw.outputTokens + retry.outputTokens }
      parsed = parseProposal(retry.result)
    }
    if (!parsed) {
      throw new Error(`${this.label} did not return a usable proposal. Try again, or switch to an API key.`)
    }

    return {
      calls: parsed.calls,
      text: parsed.text,
      // The loop only distinguishes tool_use from everything else.
      stopReason: parsed.calls.length ? 'tool_use' : 'end_turn',
      // Deliberately zero. A subscription bills nothing per step, and a
      // would-be API price would trip the task's spending limit over money
      // nobody spent. The step and wall-clock limits bound a runaway task.
      usd: 0,
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens
    }
  }

  /** One round trip, replaying the conversation first to a process that has not seen it. */
  private async ask(prompt: string): Promise<CliReply> {
    const message = !this.holdsConversation() && this.transcript.length ? `${replay(this.transcript)}\n\n${prompt}` : prompt
    const reply = await this.exchange(message)
    this.transcript.push(`<kibu>\n${prompt}\n</kibu>`, `<you>\n${reply.result}\n</you>`)
    return reply
  }
}

/**
 * The conversation so far, for a model meeting it partway through. The first
 * message (the request, and the tools) is always kept; the middle is what
 * gives way when a long task outgrows the budget.
 */
function replay(transcript: string[]): string {
  const [first, ...rest] = transcript
  const kept: string[] = []
  let size = first!.length
  for (let i = rest.length - 1; i >= 0 && size + rest[i]!.length < REPLAY_BUDGET; i--) {
    kept.unshift(rest[i]!)
    size += rest[i]!.length
  }
  const skipped = rest.length - kept.length
  return (
    'This task is already under way. Here is the conversation so far, as context rather than a new request:\n' +
    `<earlier>\n${first}\n${skipped ? `[${skipped} earlier messages left out]\n` : ''}${kept.join('\n')}\n</earlier>\n\nThe next message:`
  )
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

interface RawProposal {
  text?: unknown
  calls?: unknown
}

/**
 * Pulls the proposal out of whatever the model actually said. Exported so the
 * awkward cases — a fenced block, a sentence in front, a single call instead
 * of an array — are covered by tests rather than by hope.
 */
export function parseProposal(reply: string): { text: string; calls: PlannerProposal['calls'] } | null {
  const body = extractObject(reply)
  if (!body) return null
  let raw: RawProposal
  try {
    raw = JSON.parse(body) as RawProposal
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null

  const list = Array.isArray(raw.calls) ? raw.calls : raw.calls ? [raw.calls] : []
  const calls: PlannerProposal['calls'] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const { name, input } = entry as { name?: unknown; input?: unknown }
    if (typeof name !== 'string' || !name) continue
    calls.push({ id: `cc_${calls.length}_${Date.now().toString(36)}`, name, input: input ?? {} })
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  // A reply with neither a call nor a word is not a proposal.
  if (!calls.length && !text) return null
  return { text, calls }
}

/** Finds the outermost JSON object, ignoring fences, terminal colours and surrounding prose. */
function extractObject(reply: string): string | null {
  // eslint-disable-next-line no-control-regex
  const text = reply.replace(/\u001b\[[0-9;]*m/g, '').replace(/```(?:json)?/gi, '').trim()
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

function describe(tool: { name: string; description: string; input_schema: object }): string {
  return `- ${tool.name}: ${tool.description}\n  input: ${JSON.stringify(tool.input_schema)}`
}

export function clip(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text
}

/* ------------------------------------------------------------------ *
 * Finding and running the apps
 * ------------------------------------------------------------------ */

const found = new Map<string, string>()

/**
 * Finds a coding app's binary. An app launched from Finder inherits almost
 * no PATH, so looking it up the way a shell would is not optional here.
 */
export function resolveBinary(name: string, envOverride: string, label: string, extra: string[] = []): string {
  const cached = found.get(name)
  if (cached) return cached
  const fromEnv = process.env[envOverride]
  if (fromEnv && existsSync(fromEnv)) return remember(name, fromEnv)
  try {
    const path = execFileSync('/bin/sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' }).trim()
    if (path && existsSync(path)) return remember(name, path)
  } catch {
    // Fall through to the usual install locations.
  }
  const home = process.env.HOME ?? ''
  for (const candidate of [
    join(home, '.local/bin', name),
    join('/opt/homebrew/bin', name),
    join('/usr/local/bin', name),
    join(home, `.${name}/bin`, name),
    join(home, '.npm-global/bin', name),
    join(home, '.bun/bin', name),
    ...extra
  ]) {
    if (existsSync(candidate)) return remember(name, candidate)
  }
  throw new Error(`I could not find ${label} on this Mac. Install it, or add an Anthropic key with /keys.`)
}

function remember(name: string, path: string): string {
  found.set(name, path)
  return path
}

/**
 * Runs one CLI call to completion: the message on stdin or as an argument,
 * stdout back. A call that outlives the timeout is killed rather than left
 * holding the task.
 */
export function runOnce(bin: string, args: string[], opts: { cwd: string; input?: string; timeoutMs: number; label: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    let out = ''
    let errText = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { errText = (errText + chunk).slice(-2000) })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${opts.label} took longer than ${Math.round(opts.timeoutMs / 1000)}s to answer`))
    }, opts.timeoutMs)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(errText.trim().slice(-400) || `${opts.label} stopped (exit ${code ?? 'unknown'})`))
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(opts.input ?? '')
  })
}
