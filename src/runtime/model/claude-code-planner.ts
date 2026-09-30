import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_PROMPT } from './planner.js'
import { CliPlanner, clip, resolveBinary, type CliReply } from './cli-planner.js'

export { parseProposal } from './cli-planner.js'

/**
 * Planning through the Claude Code CLI on this Mac (`claude -p`), with every
 * Claude Code tool denied, so it can only answer. The shared behaviour (the
 * reply contract, the transcript, parsing) lives in CliPlanner; this is the
 * transport, plus the two things only Claude Code offers: a process that
 * stays open for the whole task, and a quick model for plain answers.
 *
 * See https://code.claude.com/docs/en/agent-sdk/overview for why a
 * distributed build must ship the API path instead.
 */

export interface ClaudeCodeOptions {
  /** Overrides binary discovery. */
  bin?: string
  /** A Claude Code model alias. Sonnet keeps a subscription's quota going furthest. */
  model?: string
  timeoutMs?: number
  /**
   * Injected in tests so the suite never shells out to a real CLI. When set,
   * each step is one CLI call, with the conversation replayed each time.
   */
  run?: (args: string[], input: string) => Promise<string>
  /** Injected in tests to exercise the persistent session without the CLI. */
  spawnProcess?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess
}

export class ClaudeCodePlanner extends CliPlanner {
  protected readonly label = 'Claude Code'
  /** Kibu's prompt goes in as Claude Code's system prompt instead. */
  protected override readonly inlineInstructions = false
  private readonly model: string
  private tier: 'quick' | 'full' = 'full'
  readonly quickSwapsModel = true
  private readonly timeoutMs: number
  /** One long-lived CLI process for the whole task; see StreamSession. */
  private stream: StreamSession | null = null

  constructor(private readonly options: ClaudeCodeOptions = {}) {
    super()
    this.model = options.model ?? 'sonnet'
    this.timeoutMs = options.timeoutMs ?? 180_000
  }

  setTier(tier: 'quick' | 'full'): void {
    this.tier = tier
  }

  /** Ends the CLI process. The runner calls this when the task is over. */
  dispose(): void {
    this.stream?.close()
    this.stream = null
  }

  /** Haiku for plain answers, unless the user already chose something lighter. */
  private get activeModel(): string {
    return this.tier === 'quick' ? quickModel(this.model) : this.model
  }

  protected holdsConversation(): boolean {
    return !this.options.run && !!this.stream?.alive && this.stream.model === this.activeModel
  }

  /**
   * The CLI process for this task, started on first use, or taken from the
   * one started ahead of time. A model change starts a new process, since a
   * running one keeps the model it started with; the transcript catches it up.
   */
  private streamFor(): StreamSession {
    const model = this.activeModel
    if (this.stream && this.stream.model === model && this.stream.alive) return this.stream
    this.stream?.close()
    const custom = this.options.bin || this.options.spawnProcess
    const warmed = !custom ? takeWarm(model) : null
    if (warmed) return (this.stream = warmed)
    const args = cliArgs(model)
    const env = cliEnv(model)
    const bin = this.options.bin ?? resolveBin()
    this.stream = new StreamSession(model, this.options.spawnProcess ? this.options.spawnProcess(bin, args, env) : spawnCli(bin, args, env))
    return this.stream
  }

  protected async exchange(message: string): Promise<CliReply> {
    const stdout = this.options.run
      ? await this.options.run(['-p', '--output-format', 'json', '--model', this.activeModel, ...commonArgs()], message)
      : JSON.stringify(await this.streamFor().send(message, this.timeoutMs))
    let envelope: Record<string, unknown>
    try {
      envelope = JSON.parse(stdout) as Record<string, unknown>
    } catch {
      throw new Error(`Claude Code returned something unreadable: ${clip(stdout, 200)}`)
    }
    if (envelope.is_error) {
      throw new Error(String(envelope.result ?? 'Claude Code reported an error'))
    }
    const usage = (envelope.usage ?? {}) as Record<string, number>
    return {
      result: String(envelope.result ?? ''),
      inputTokens:
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0
    }
  }
}

/* ------------------------------------------------------------------ *
 * The CLI itself
 * ------------------------------------------------------------------ */

/** Flags every planning call shares: Claude Code as a pure answerer. */
function commonArgs(): string[] {
  return [
    // Claude Code's own tools are not loaded at all, and none is permitted:
    // this process only ever answers. Not loading them also keeps their
    // definitions out of every prompt.
    '--tools',
    '',
    '--allowed-tools',
    '',
    // Nothing from the user's MCP servers, settings, hooks or skills joins
    // the conversation.
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    // Kibu keeps each task's conversation itself, in its own history. Left
    // to its defaults the CLI would also write a transcript of every Kibu
    // request under ~/.claude/projects, where deleting it in Kibu cannot reach.
    '--no-session-persistence',
    // Kibu's prompt replaces Claude Code's coding-agent prompt rather than
    // being appended to it. That prompt is tens of thousands of tokens about
    // writing software; replacing it takes a trivial step from about four
    // seconds to about one and a half.
    '--system-prompt',
    SYSTEM_PROMPT
  ]
}

/** The model a quick job runs on: Haiku, unless the user already chose something lighter. */
export function quickModel(model: string): string {
  return /haiku/i.test(model) ? model : 'haiku'
}

/** Arguments for one long-lived CLI session. */
function cliArgs(model: string): string[] {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model, ...commonArgs()]
}

function cliEnv(model: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: 'kibu',
    // Choosing one tool call does not need a chain of thought, and on the
    // quick model thinking roughly doubles the time a step takes.
    ...(model === 'haiku' ? { MAX_THINKING_TOKENS: '0' } : {})
  }
}

/*
 * One process started ahead of time. Starting the CLI costs about two seconds,
 * more than a short answer takes, so the next task's process is started
 * while the person is still reading the last answer, and sits waiting on stdin.
 */
const warm = new Map<string, StreamSession>()

/** Starts a process for the next task on each model, unless a live one is already waiting. */
export function prewarmClaudeCode(...models: string[]): void {
  for (const model of new Set(models)) {
    if (warm.get(model)?.alive) continue
    try {
      warm.set(model, new StreamSession(model, spawnCli(resolveBin(), cliArgs(model), cliEnv(model))))
    } catch {
      // No CLI to warm: the planner reports that properly when it is needed.
    }
  }
}

/** Hands over the waiting process for this model, if it is still alive. */
function takeWarm(model: string): StreamSession | null {
  const taken = warm.get(model)
  warm.delete(model)
  return taken?.alive ? taken : null
}

/** Ends the waiting processes, e.g. when the runtime shuts down. */
export function disposeWarmClaudeCode(): void {
  for (const session of warm.values()) session.close()
  warm.clear()
}

function spawnCli(bin: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  // A neutral directory: the planner must not pick up the CLAUDE.md or
  // settings of whatever project the user happens to be sitting in.
  return spawn(bin, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] })
}

/**
 * One Claude Code process kept open for a whole task, fed one user message
 * per planning step over stream-json.
 *
 * Starting the CLI costs about two seconds every time. A task takes several
 * steps, so starting it once instead of once per step is most of the
 * difference between a step taking four seconds and taking one.
 */
export class StreamSession {
  private buffer = ''
  private stderr = ''
  private pending: { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null
  alive = true

  constructor(readonly model: string, private readonly child: ChildProcess) {
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.read(chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => { this.stderr = (this.stderr + String(chunk)).slice(-2000) })
    const end = (why: string): void => {
      this.alive = false
      this.fail(new Error(this.stderr.trim().slice(-400) || why))
    }
    child.on('error', (err) => end(err.message))
    child.on('exit', (code) => end(`Claude Code stopped (exit ${code ?? 'unknown'})`))
    // A closed pipe after the process died must not crash the runtime.
    child.stdin?.on('error', () => {})
  }

  send(text: string, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.alive) return Promise.reject(new Error(this.stderr.trim().slice(-400) || 'Claude Code is not running'))
    if (this.pending) return Promise.reject(new Error('a planning step is already in flight'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Claude Code took longer than ${Math.round(timeoutMs / 1000)}s to answer`))
        this.close()
      }, timeoutMs)
      this.pending = { resolve, reject, timer }
      this.child.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
    })
  }

  close(): void {
    this.alive = false
    this.child.stdin?.end()
    if (this.child.exitCode === null) this.child.kill()
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      // Everything before the result (system init, assistant turns) is
      // progress; the result carries the same envelope as --output-format json.
      if (message.type === 'result' && this.pending) {
        const { resolve, timer } = this.pending
        clearTimeout(timer)
        this.pending = null
        resolve(message)
      }
    }
  }

  private fail(err: Error): void {
    if (!this.pending) return
    const { reject, timer } = this.pending
    clearTimeout(timer)
    this.pending = null
    reject(err)
  }
}

/** Finds the `claude` binary. */
export function resolveBin(): string {
  return resolveBinary('claude', 'KIBU_CLAUDE_BIN', 'Claude Code', [join(process.env.HOME ?? '', '.claude/local/claude')])
}

/** True when the CLI is present, used to offer the option only when it works. */
export function claudeCodeAvailable(): boolean {
  try {
    resolveBin()
    return true
  } catch {
    return false
  }
}
