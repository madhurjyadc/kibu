import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliPlanner, resolveBinary, runOnce, type CliReply } from './cli-planner.js'
import { ClaudeCodePlanner, claudeCodeAvailable } from './claude-code-planner.js'
import type { PlannerLike } from './planner.js'
import type { CodingApp, CodingAppStatus, ModelConfig } from '../../shared/protocol.js'

/**
 * Codex and OpenCode, as planners.
 *
 * Neither keeps a process open between messages the way Claude Code's
 * stream mode does, so each step is one call with the conversation replayed
 * from Kibu's own transcript. Each runs in a scratch folder of its own, so
 * no project's instructions or settings join in.
 */

const TIMEOUT_MS = 180_000

/** A folder of its own for one task, removed when the task ends. */
function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * `codex exec`, read-only and ephemeral. Codex has no switch for its own
 * tools, so its sandbox is read-only and it is told it only plans; it never
 * saves the session (`--ephemeral`), and its final message is read from the
 * file `-o` writes rather than parsed out of its progress output.
 */
export class CodexPlanner extends CliPlanner {
  protected readonly label = 'Codex'
  private readonly dir = scratch('kibu-codex-')

  constructor(private readonly model = '') {
    super()
  }

  protected holdsConversation(): boolean {
    return false
  }

  protected async exchange(message: string): Promise<CliReply> {
    const out = join(this.dir, 'reply.txt')
    rmSync(out, { force: true })
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-o', out, ...(this.model ? ['-m', this.model] : []), '-']
    await runOnce(resolveCodex(), args, { cwd: this.dir, input: message, timeoutMs: TIMEOUT_MS, label: 'Codex' })
    let result = ''
    try {
      result = readFileSync(out, 'utf8')
    } catch {
      throw new Error('Codex finished without a reply.')
    }
    return { result, inputTokens: 0, outputTokens: 0 }
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

/**
 * `opencode run`, in a folder whose opencode.json denies every tool, so it
 * can only answer.
 */
export class OpenCodePlanner extends CliPlanner {
  protected readonly label = 'OpenCode'
  private readonly dir = scratch('kibu-opencode-')

  constructor(private readonly model = '') {
    super()
    writeFileSync(join(this.dir, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: { '*': 'deny' } }, null, 2))
  }

  protected holdsConversation(): boolean {
    return false
  }

  protected async exchange(message: string): Promise<CliReply> {
    const args = ['run', ...(this.model ? ['-m', this.model] : []), message]
    const result = await runOnce(resolveOpenCode(), args, { cwd: this.dir, timeoutMs: TIMEOUT_MS, label: 'OpenCode' })
    return { result, inputTokens: 0, outputTokens: 0 }
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

export function resolveCodex(): string {
  return resolveBinary('codex', 'KIBU_CODEX_BIN', 'Codex')
}

export function resolveOpenCode(): string {
  return resolveBinary('opencode', 'KIBU_OPENCODE_BIN', 'OpenCode', [join(process.env.HOME ?? '', '.opencode/bin/opencode')])
}

function installed(find: () => string): boolean {
  try {
    find()
    return true
  } catch {
    return false
  }
}

export const CODING_APP_LABELS: Record<CodingApp, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }

/** Which coding apps are on this Mac. */
export function codingAppStatus(): CodingAppStatus[] {
  return [
    { id: 'claude-code', label: CODING_APP_LABELS['claude-code'], available: claudeCodeAvailable() },
    { id: 'codex', label: CODING_APP_LABELS.codex, available: installed(resolveCodex) },
    { id: 'opencode', label: CODING_APP_LABELS.opencode, available: installed(resolveOpenCode) }
  ]
}

export function codingAppAvailable(app: CodingApp): boolean {
  return codingAppStatus().find((a) => a.id === app)?.available ?? false
}

/** The planner for a coding app, with the model the user chose for it. */
export function createCodingAppPlanner(app: CodingApp, model: ModelConfig): PlannerLike {
  if (app === 'codex') return new CodexPlanner(model.codex)
  if (app === 'opencode') return new OpenCodePlanner(model.opencode)
  return new ClaudeCodePlanner({ model: model.claudeCode })
}
