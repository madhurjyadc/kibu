import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_PROMPT, type PlannerLike, type PlannerProposal, type ToolResultInput } from './planner.js'
import type { TaskState } from '../../shared/types.js'

/**
 * A planner that runs through the locally installed Claude Code CLI instead of
 * the Anthropic API.
 *
 * Why this exists: Kibu's loop needs a model that can propose tool calls, but
 * the API bills per token and not everyone has credit. Anybody who already
 * uses Claude Code has a model on their machine that is already authenticated.
 * This drives it in print mode (`claude -p`), with every Claude Code tool
 * denied, so it can only answer — it proposes, and Kibu's own loop still does
 * every check, execution, verification and undo exactly as before.
 *
 * Scope, stated plainly: this is for running Kibu on your own machine with
 * your own Claude Code login. Anthropic does not permit third-party products
 * to offer claude.ai login or subscription rate limits to *their* users
 * without prior approval, so a distributed build of Kibu must ship the API
 * path instead. See https://code.claude.com/docs/en/agent-sdk/overview.
 */

export interface ClaudeCodeOptions {
  /** Overrides binary discovery. */
  bin?: string
  /** A Claude Code model alias. Sonnet keeps a subscription's quota going furthest. */
  model?: string
  timeoutMs?: number
  /** Injected in tests so the suite never shells out to a real CLI. */
  run?: (args: string[], input: string) => Promise<string>
}

/** The shape the CLI is asked to reply in. */
interface RawProposal {
  text?: unknown
  calls?: unknown
}

const REPLY_CONTRACT = `Reply with ONE JSON object and nothing else — no prose around it, no markdown fence:

{"text": "<a short line about what you are doing, may be empty>",
 "calls": [{"name": "<tool name>", "input": { ... }}]}

Propose one step at a time unless several calls are genuinely independent. Use only the tools listed above, with exactly those input fields. If the task is finished, call finish. If you need the user, call ask_user.`

export class ClaudeCodePlanner implements PlannerLike {
  private sessionId: string | null = null
  private seed_: string[] = []
  private pending: string[] = []
  private readonly model: string
  private readonly timeoutMs: number

  constructor(private readonly options: ClaudeCodeOptions = {}) {
    this.model = options.model ?? 'sonnet'
    this.timeoutMs = options.timeoutMs ?? 180_000
  }

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
    const first = this.sessionId === null
    const parts: string[] = []
    if (first) {
      parts.push(...this.seed_)
      parts.push(`Tools you may call:\n${tools.map(describe).join('\n\n')}`)
    } else if (this.pending.length === 0) {
      parts.push('Continue.')
    }
    parts.push(...this.pending)
    this.pending = []
    parts.push(REPLY_CONTRACT)

    let raw = await this.ask(parts.join('\n\n'))
    let parsed = parseProposal(raw.result)
    if (!parsed) {
      // One nudge, in the same session, before giving up. Models occasionally
      // wrap the object in prose despite the contract.
      const retry = await this.ask('That was not parseable. Send the JSON object only, nothing else.')
      raw = { ...retry, usd: raw.usd + retry.usd, inputTokens: raw.inputTokens + retry.inputTokens, outputTokens: raw.outputTokens + retry.outputTokens }
      parsed = parseProposal(retry.result)
    }
    if (!parsed) {
      throw new Error('Claude Code did not return a usable proposal. Try again, or switch to an API key.')
    }

    return {
      calls: parsed.calls,
      text: parsed.text,
      // The loop only distinguishes tool_use from everything else.
      stopReason: parsed.calls.length ? 'tool_use' : 'end_turn',
      usd: raw.usd,
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens
    }
  }

  /** One round trip to the CLI. */
  private async ask(
    prompt: string
  ): Promise<{ result: string; usd: number; inputTokens: number; outputTokens: number }> {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      this.model,
      // Claude Code's own tools stay off: this process only ever answers.
      '--allowed-tools',
      '',
      // Nothing from the user's MCP config joins the conversation.
      '--strict-mcp-config',
      '--append-system-prompt',
      SYSTEM_PROMPT
    ]
    if (this.sessionId) args.push('--resume', this.sessionId)

    const stdout = this.options.run
      ? await this.options.run(args, prompt)
      : await runCli(this.options.bin ?? resolveBin(), args, prompt, this.timeoutMs)

    let envelope: Record<string, unknown>
    try {
      envelope = JSON.parse(stdout) as Record<string, unknown>
    } catch {
      throw new Error(`Claude Code returned something unreadable: ${clip(stdout, 200)}`)
    }
    if (envelope.is_error) {
      throw new Error(String(envelope.result ?? 'Claude Code reported an error'))
    }
    if (typeof envelope.session_id === 'string') this.sessionId = envelope.session_id

    const usage = (envelope.usage ?? {}) as Record<string, number>
    return {
      result: String(envelope.result ?? ''),
      // Deliberately zero. The CLI reports what this turn *would* have cost on
      // the API, but on a subscription nothing is billed — reporting that
      // number would trip the task's spending limit over money nobody spent,
      // and would show the user a charge that does not exist. The step limit
      // and the wall-clock limit are what bound a runaway task on this path.
      usd: 0,
      inputTokens:
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0
    }
  }
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

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

/** Finds the outermost JSON object, ignoring fences and surrounding prose. */
function extractObject(reply: string): string | null {
  const text = reply.replace(/```(?:json)?/gi, '').trim()
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

function clip(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text
}

/* ------------------------------------------------------------------ *
 * The CLI itself
 * ------------------------------------------------------------------ */

function runCli(bin: string, args: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        // A neutral directory: the planner must not pick up the CLAUDE.md or
        // settings of whatever project the user happens to be sitting in.
        cwd: tmpdir(),
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'kibu' }
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message).trim()
          reject(new Error(detail.slice(0, 400) || 'Claude Code could not be run'))
          return
        }
        resolve(stdout)
      }
    )
    child.stdin?.end(input)
  })
}

let cachedBin: string | null = null

/**
 * Finds the `claude` binary. An app launched from Finder inherits almost no
 * PATH, so looking it up the way a shell would is not optional here.
 */
export function resolveBin(): string {
  if (cachedBin) return cachedBin
  const fromEnv = process.env.KIBU_CLAUDE_BIN
  if (fromEnv && existsSync(fromEnv)) return (cachedBin = fromEnv)

  try {
    const found = execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim()
    if (found && existsSync(found)) return (cachedBin = found)
  } catch {
    // Fall through to the usual install locations.
  }
  const home = process.env.HOME ?? ''
  for (const candidate of [
    join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.claude/local/claude')
  ]) {
    if (existsSync(candidate)) return (cachedBin = candidate)
  }
  throw new Error('I could not find Claude Code on this Mac. Install it, or add an Anthropic key with /keys.')
}

/** True when the CLI is present — used to offer the option only when it works. */
export function claudeCodeAvailable(): boolean {
  try {
    resolveBin()
    return true
  } catch {
    return false
  }
}
