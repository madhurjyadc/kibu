import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { validCodingModel, type CodingApp, type CodingModel, type CodingModelCatalog } from '../../shared/protocol.js'
import { resolveCodex, resolveOpenCode } from './coding-apps.js'
import { resolveBin } from './claude-code-planner.js'
import { runOnce } from './cli-planner.js'

const DISCOVERY_TIMEOUT = 15_000
const modelId = z.string().min(1).refine(validCodingModel)
const codexPage = z.object({
  data: z.array(z.object({ model: modelId, displayName: z.string().optional(), description: z.string().optional(), isDefault: z.boolean().optional(), hidden: z.boolean().optional() })),
  nextCursor: z.string().nullable().optional()
})

/** Metadata only. Opening a picker never generates tokens or changes a person's CLI settings. */
export async function codingModels(app: CodingApp, refresh = false): Promise<CodingModelCatalog> {
  const dir = mkdtempSync(join(tmpdir(), 'kibu-models-'))
  try {
    if (app === 'claude-code') return await discoverClaudeModels(resolveBin(), dir)
    if (app === 'codex') return await discoverCodexCatalog(resolveCodex(), dir)
    let refreshFailed = false
    if (refresh) {
      try { await runOnce(resolveOpenCode(), ['models', '--refresh', '--verbose'], { cwd: dir, timeoutMs: DISCOVERY_TIMEOUT, label: 'OpenCode model refresh' }) }
      catch { refreshFailed = true }
    }
    try {
      const catalog = await discoverOpenCodeModels(resolveOpenCode(), dir)
      if (refreshFailed) catalog.note = 'Couldn’t refresh OpenCode’s online catalog. Showing its locally known models. ' + catalog.note
      return catalog
    }
    catch {
      // Older OpenCode versions may not provide the server metadata endpoints.
      const output = await runOnce(resolveOpenCode(), ['models', '--verbose'], { cwd: dir, timeoutMs: DISCOVERY_TIMEOUT, label: 'OpenCode model list' })
      return { models: parseOpenCodeModels(output), connection: 'OpenCode · connection details unavailable', note: 'Your OpenCode version lists models without connection details. Check a model before using it. Update OpenCode for provider recommendations.' }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** Bounded JSONL RPC transport shared by the two CLI control protocols. */
function jsonLines<T>(bin: string, args: string[], cwd: string, label: string, start: (send: (value: object) => void, finish: (value: T) => void) => (message: any) => void, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = createInterface({ input: child.stdout })
    let settled = false
    const finish = (value?: T, error?: Error): void => {
      if (settled) return
      settled = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill()
      if (error) reject(error); else resolve(value!)
    }
    const timer = setTimeout(() => finish(undefined, new Error(`${label} took too long to list models. Try Refresh or enter a model ID.`)), timeoutMs)
    child.stdin.on('error', () => finish(undefined, new Error(`Couldn’t connect to ${label}. Check its installation and login.`)))
    child.on('error', () => finish(undefined, new Error(`Couldn’t start ${label}. Check its installation.`)))
    child.on('close', () => finish(undefined, new Error(`${label} stopped before listing models. Update it or enter a model ID.`)))
    child.stderr.resume()
    const send = (value: object): void => { if (!settled) child.stdin.write(JSON.stringify(value) + '\n') }
    const onMessage = start(send, (value) => finish(value))
    lines.on('line', (line) => {
      if (settled) return
      let message: any
      try { message = JSON.parse(line) } catch { return } // Ignore older CLIs' startup messages.
      try { onMessage(message) }
      catch { finish(undefined, new Error(`Couldn’t read ${label} models. Check your login or update the app.`)) }
    })
  })
}

export function discoverCodexModels(bin: string, cwd: string, timeoutMs = DISCOVERY_TIMEOUT): Promise<CodingModel[]> {
  return discoverCodexCatalog(bin, cwd, timeoutMs).then((catalog) => catalog.models)
}

export function discoverCodexCatalog(bin: string, cwd: string, timeoutMs = DISCOVERY_TIMEOUT): Promise<CodingModelCatalog> {
  return jsonLines(bin, ['app-server'], cwd, 'Codex', (send, finish) => {
    let id = 1
    let stage = 'initialize'
    let connection = 'Codex · connection details unavailable'
    let blocked = false
    let defaultModel: string | undefined
    const models = new Map<string, CodingModel>()
    const cursors = new Set<string>()
    const request = (method: string, params: object): void => { stage = method; send({ method, id: ++id, params }) }
    send({ method: 'initialize', id, params: { clientInfo: { name: 'kibu', title: 'Kibu', version: '0.1.0' } } })
    return (message) => {
      if (message.id !== id) return
      if (stage === 'initialize') {
        if (message.error) throw new Error('initialize failed')
        send({ method: 'initialized', params: {} }); request('account/read', { refreshToken: false }); return
      }
      if (stage === 'account/read') {
        const result = message.result
        const account = result?.account
        blocked = !message.error && result?.requiresOpenaiAuth === true && account === null
        if (blocked) connection = 'Codex · sign-in required'
        else if (account?.type === 'chatgpt') connection = `ChatGPT · ${safePlan(account.planType)}`
        else if (account?.type === 'apiKey') connection = 'Codex · API billing'
        else if (result?.requiresOpenaiAuth === false) connection = 'Codex · configured provider'
        request('config/read', { includeLayers: false }); return
      }
      if (stage === 'config/read') {
        const value = message.result?.config?.model
        if (typeof value === 'string' && validCodingModel(value)) defaultModel = value
        request('model/list', { limit: 100 }); return
      }
      if (message.error) throw new Error('model list failed')
      const page = codexPage.parse(message.result)
      for (const model of page.data) {
        if (!model.hidden) models.set(model.model, {
          id: model.model, label: model.displayName || model.model, description: model.description,
          recommended: !blocked && model.isDefault, recommendation: model.isDefault ? 'Codex recommends this model for your connection.' : undefined,
          access: blocked ? 'unavailable' : 'listed', reason: blocked ? 'Sign in to Codex, then refresh models.' : undefined
        })
      }
      if (!page.nextCursor) {
        finish({ models: [...models.values()], connection, defaultModel, note: 'Models come from your Codex connection. Plan access and remaining quota are checked when you use a model; a listed model is not a guarantee of access.' }); return
      }
      if (cursors.has(page.nextCursor) || cursors.size >= 20) throw new Error('incomplete list')
      cursors.add(page.nextCursor); request('model/list', { limit: 100, cursor: page.nextCursor })
    }
  }, timeoutMs)
}

export function discoverClaudeModels(bin: string, cwd: string, timeoutMs = DISCOVERY_TIMEOUT): Promise<CodingModelCatalog> {
  return jsonLines(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence'], cwd, 'Claude Code', (send, finish) => {
    const requestId = randomUUID()
    send({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', hooks: {} } })
    return (message) => {
      if (message.type !== 'control_response' || message.response?.request_id !== requestId) return
      if (message.response.subtype !== 'success') throw new Error('initialize failed')
      const result = z.object({
        models: z.array(z.object({ value: modelId, displayName: z.string(), description: z.string().optional(), resolvedModel: z.string().optional() })),
        account: z.object({ subscriptionType: z.string().nullable().optional(), tokenSource: z.string().optional(), apiKeySource: z.string().nullable().optional() }).optional()
      }).parse(message.response.response)
      const account = result.account
      const blocked = account?.tokenSource === 'none' && (!account.apiKeySource || account.apiKeySource === 'none') && !process.env.CLAUDE_CODE_USE_BEDROCK && !process.env.CLAUDE_CODE_USE_VERTEX && !process.env.CLAUDE_CODE_USE_FOUNDRY
      const models = result.models.map((model): CodingModel => ({
        id: model.value, label: model.displayName, description: model.description, resolvedModel: model.resolvedModel,
        recommended: !blocked && model.value === 'default', recommendation: model.value === 'default' ? 'Claude Code recommends this model for your connection.' : undefined,
        access: blocked ? 'unavailable' : 'listed', reason: blocked ? 'Sign in to Claude Code or connect a provider, then refresh models.' : undefined
      }))
      finish({ models, connection: blocked ? 'Claude Code · sign-in required' : account?.subscriptionType ? `Claude · ${safePlan(account.subscriptionType)}` : 'Claude Code · configured connection', defaultModel: models.find((model) => model.id === 'default')?.resolvedModel, note: 'Models are reported by your installed Claude Code. Check access before selecting. Kibu uses your chosen model for answers and tasks.' })
    }
  }, timeoutMs)
}

function safePlan(value: unknown): string {
  // Never send emails, credentials or an arbitrary server object to the renderer.
  return typeof value === 'string' && /^[a-zA-Z0-9 _-]{1,40}$/.test(value) ? value.replace(/_/g, ' ') : 'plan not reported'
}

const openCodeProvider = z.object({
  id: z.string(), name: z.string().optional(),
  models: z.record(z.string(), z.object({ id: z.string(), name: z.string().optional(), release_date: z.string().optional(), status: z.string().optional(), cost: z.object({ input: z.number(), output: z.number() }).optional(), capabilities: z.object({ input: z.object({ text: z.boolean().optional() }).optional(), output: z.object({ text: z.boolean().optional() }).optional() }).optional() }))
})

/** Connected providers and defaults are read from OpenCode, never from raw credential files. */
export function parseOpenCodeProviders(value: unknown, configuredModel?: string): CodingModelCatalog {
  const catalog = z.object({ all: z.array(openCodeProvider), connected: z.array(z.string()), default: z.record(z.string(), z.string()).optional() }).parse(value)
  const models: CodingModel[] = []
  for (const provider of catalog.all) for (const [key, model] of Object.entries(provider.models)) {
    const id = `${provider.id}/${model.id || key}`
    if (!validCodingModel(id)) continue
    const connected = catalog.connected.includes(provider.id)
    const unsupported = model.capabilities?.input?.text === false || model.capabilities?.output?.text === false || model.status === 'deprecated'
    models.push({ id, label: `${model.name || model.id} · ${provider.name || provider.id}`, description: id,
      free: model.cost ? model.cost.input === 0 && model.cost.output === 0 : undefined,
      access: !connected || unsupported ? 'unavailable' : 'listed',
      reason: !connected ? `Connect ${provider.name || provider.id} in OpenCode, then refresh.` : unsupported ? 'This model is retired or does not accept text.' : undefined
    })
  }
  // Honor a configured model. Otherwise prefer a free provider default, then a connected provider default.
  const eligible = models.filter((model) => model.access !== 'unavailable')
  const defaults = eligible.filter((model) => catalog.default?.[model.id.split('/')[0]!] === model.id.slice(model.id.indexOf('/') + 1))
  const recommended = eligible.find((model) => model.id === configuredModel) || defaults.find((model) => model.free) || eligible.find((model) => model.free) || defaults[0]
  if (recommended) {
    recommended.recommended = true
    recommended.recommendation = recommended.id === configuredModel ? 'Your configured OpenCode model.' : recommended.free ? 'A model from a connected provider with reported free pricing.' : 'A default model from a connected provider. Provider charges may apply.'
  }
  models.sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true) || Number(a.access === 'unavailable') - Number(b.access === 'unavailable') || a.label.localeCompare(b.label))
  return { models, defaultModel: configuredModel, connection: catalog.connected.length ? `OpenCode · ${catalog.connected.length} connected provider${catalog.connected.length === 1 ? '' : 's'}` : 'OpenCode · no connected providers', note: 'Unconnected providers are grayed out. Connected models still need an access check: subscriptions, credits and quotas vary. Free means the catalog reports zero input and output prices; provider limits still apply.' }
}

export function discoverOpenCodeModels(bin: string, cwd: string, timeoutMs = DISCOVERY_TIMEOUT): Promise<CodingModelCatalog> {
  // Use a private, authenticated local server with an OS-assigned port. It is closed after metadata is read.
  const password = randomUUID()
  writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({ permission: { '*': 'deny' } }))
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd, env: { ...process.env, OPENCODE_SERVER_USERNAME: 'kibu', OPENCODE_SERVER_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = createInterface({ input: child.stdout })
    const abort = new AbortController()
    let settled = false; let reading = false
    const finish = (result?: CodingModelCatalog, error?: Error): void => {
      if (settled) return
      settled = true; clearTimeout(timer); abort.abort(); lines.close(); child.kill()
      if (error) reject(error); else resolve(result!)
    }
    const timer = setTimeout(() => finish(undefined, new Error('OpenCode model discovery timed out.')), timeoutMs)
    child.on('error', () => finish(undefined, new Error('Couldn’t start OpenCode.')))
    child.on('close', () => finish(undefined, new Error('OpenCode stopped before listing models.')))
    child.stderr.resume()
    lines.on('line', (line) => {
      const match = line.match(/opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (!match || reading || settled) return
      reading = true
      const port = Number(match[1]); if (port < 1 || port > 65535) { finish(undefined, new Error('Invalid local port.')); return }
      const get = async (path: string): Promise<any> => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: abort.signal, redirect: 'error', headers: { Authorization: `Basic ${Buffer.from(`kibu:${password}`).toString('base64')}`, 'x-opencode-directory': cwd } })
        if (!response.ok) throw new Error('OpenCode metadata unavailable')
        return response.json()
      }
      void Promise.all([get('/provider'), get('/config').catch(() => null)])
        .then(([providers, config]) => finish(parseOpenCodeProviders(providers, typeof config?.model === 'string' && validCodingModel(config.model) ? config.model : undefined)))
        .catch(() => finish(undefined, new Error('Couldn’t read OpenCode providers.')))
    })
  })
}

/** Fallback for older OpenCode CLIs: unknown prices and access remain unknown. */
export function parseOpenCodeModels(output: string): CodingModel[] {
  const models = new Map<string, CodingModel>()
  let id = ''; let metadata: string[] = []
  const flush = (): void => {
    if (!id) return
    const model: CodingModel = { id, label: id, access: 'listed' }
    try {
      const parsed = z.object({ name: z.string().optional(), cost: z.object({ input: z.number(), output: z.number() }).optional() }).parse(JSON.parse(metadata.join('\n')))
      model.label = parsed.name ? `${parsed.name} · ${id}` : id
      model.free = parsed.cost ? parsed.cost.input === 0 && parsed.cost.output === 0 : undefined
    } catch { /* Keep IDs from older CLIs selectable. */ }
    models.set(id, model)
  }
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const value = line.trim()
    if (validCodingModel(value) && value.includes('/') && !value.startsWith('/') && !value.endsWith('/')) { flush(); id = value; metadata = [] }
    else if (id) metadata.push(line)
  }
  flush(); return [...models.values()]
}
