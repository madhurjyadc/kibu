import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validCodingModel, type CodingApp, type CodingModelCheck } from '../../shared/protocol.js'
import { resolveCodex, resolveOpenCode } from './coding-apps.js'
import { resolveBin } from './claude-code-planner.js'
import { discoverClaudeModels } from './coding-models.js'
import { runOnce } from './cli-planner.js'

const PROMPT = 'Do not use any tools. Reply with exactly KIBU_OK and nothing else.'
const TIMEOUT = 30_000

/** Only called by an explicit Check & use click. One short reply may consume quota or incur provider charges. */
export async function checkCodingModel(app: CodingApp, model: string): Promise<CodingModelCheck> {
  if (!model || !validCodingModel(model)) return { ok: false, message: 'Enter a valid model ID.' }
  if (app === 'opencode' && (!model.includes('/') || model.startsWith('/') || model.endsWith('/'))) return { ok: false, message: 'OpenCode needs a provider/model ID, for example provider/model-name.' }
  const dir = mkdtempSync(join(tmpdir(), 'kibu-model-check-'))
  try {
    if (app === 'claude-code') {
      const bin = resolveBin()
      const catalog = await discoverClaudeModels(bin, dir).catch(() => null)
      const entry = catalog?.models.find((entry) => entry.id === model)
      if (entry?.access === 'unavailable') return { ok: false, unavailable: true, message: entry.reason! }
      const output = await runOnce(bin, ['-p', '--output-format', 'json', '--model', model, '--tools', '', '--allowed-tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--max-turns', '1', '--system-prompt', 'Answer the model connection check only.'], { cwd: dir, input: PROMPT, timeoutMs: TIMEOUT, label: 'Claude Code model check' })
      return parseClaudeCheck(output, model, entry?.resolvedModel)
    }
    if (app === 'codex') {
      const out = join(dir, 'reply.txt')
      const output = await runOnce(resolveCodex(), ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', model, '-o', out, '-'], { cwd: dir, input: PROMPT, timeoutMs: TIMEOUT, label: 'Codex model check' })
      const events = jsonEvents(output)
      const error = events.find((event) => event.type === 'error' || event.type === 'turn.failed')
      if (error) return modelCheckFailure(JSON.stringify(error))
      let text = ''; try { text = readFileSync(out, 'utf8') } catch { /* Missing replies are not success. */ }
      return checkedReply(text, model)
    }
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ permission: { '*': 'deny' } }))
    const output = await runOnce(resolveOpenCode(), ['run', '--format', 'json', '-m', model, PROMPT], { cwd: dir, timeoutMs: TIMEOUT, label: 'OpenCode model check' })
    return parseOpenCodeCheck(output, model)
  } catch (error) { return modelCheckFailure(error instanceof Error ? error.message : '') }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

function jsonEvents(output: string): any[] {
  return output.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
}

function checkedReply(text: string, model: string): CodingModelCheck {
  return text.trim() === 'KIBU_OK'
    ? { ok: true, resolvedModel: model, message: 'Access checked. This model is ready to use.' }
    : { ok: false, message: 'The model did not complete the connection check. Try again or choose another model.' }
}

export function parseClaudeCheck(output: string, requested: string, expected?: string): CodingModelCheck {
  let result: any
  try { result = JSON.parse(output) } catch { return { ok: false, message: 'Couldn’t read the model check. Update Claude Code or try again.' } }
  if (result.is_error) return modelCheckFailure(`${result.result || ''} ${JSON.stringify(result.errors || [])}`)
  const models = Object.keys(result.modelUsage || {})
  const normalized = (id: string): string => id.replace(/\[1m\]$/, '')
  // Managed policies can substitute a denied --model. Do not silently save a model that never answered.
  const target = normalized(expected || requested)
  const actual = models.find((id) => normalized(id) === target || (!expected && ['sonnet', 'opus', 'haiku'].includes(requested) && id.startsWith(`claude-${requested}-`)) || (!expected && requested === 'default'))
  if (!actual) return { ok: false, unavailable: models.length > 0, message: models.length ? 'Claude Code answered with a different model. Your account or administrator may restrict this choice. Refresh models and choose an allowed model.' : 'Claude Code did not report which model answered. Update Claude Code and try again.' }
  return checkedReply(String(result.result || ''), actual)
}

export function parseOpenCodeCheck(output: string, model: string): CodingModelCheck {
  const events = jsonEvents(output)
  const error = events.find((event) => event.type === 'error')
  if (error) return modelCheckFailure(JSON.stringify(error.error || error))
  return checkedReply(events.filter((event) => event.type === 'text').map((event) => event.part?.text || '').join(''), model)
}

/** Return actionable, credential-free messages, not raw CLI errors (which may contain keys or paths). */
export function modelCheckFailure(error: string): CodingModelCheck {
  if (/quota|rate.?limit|usage.?limit|insufficient.?credit|insufficient_quota|limit.?reached|credit.?balance/i.test(error)) return { ok: false, unavailable: true, message: 'Usage limits or credits are exhausted for this connection. Wait for a reset or update your provider account, then refresh models.' }
  if (/401|unauthorized|authentication|not.?logged|sign.?in|log.?in|login|api.?key.*(?:missing|invalid)|no.*credentials/i.test(error)) return { ok: false, unavailable: true, message: 'Sign in or reconnect this provider in your coding app, then refresh models.' }
  if (/403|404|not.?found|not.?supported|unsupported|does.?not.?exist|not.?available|unavailable|not.*access|access.*denied|permission.?denied|not.*plan|upgrade.*plan|requires.*(?:pro|plus|paid|subscription)|modelnotfound/i.test(error)) return { ok: false, unavailable: true, message: 'This model is unavailable for your connection or plan. Choose another model, or update access in your coding app and refresh.' }
  if (/find|ENOENT|install/i.test(error)) return { ok: false, message: 'The coding app could not be started. Check its installation, then retry.' }
  if (/too.?long|longer.?than|timeout|timed.?out/i.test(error)) return { ok: false, message: 'The access check timed out. Check your connection and retry.' }
  return { ok: false, message: 'Couldn’t check model access. Check your connection and provider setup, then retry. Your previous model is still selected.' }
}
