/**
 * Agent runtime entry point.
 *
 * This runs as its own OS process, forked by the Electron main process. It
 * holds every privileged capability (filesystem, accessibility, browser) and
 * talks to the host over a narrow, typed message channel. The UI renderer has
 * no path to any of it.
 */
import { randomUUID } from 'node:crypto'
import type { BrainRequest, BrainSnapshot } from '../shared/brain.js'
import { documentTools } from './tools/documents.js'
import { brainTools } from './tools/brain.js'
import { join } from 'node:path'
import { ToolRegistry } from './tools/registry.js'
import { fileTools } from './tools/files.js'
import { shellTools } from './tools/shell.js'
import { userTools } from './tools/user.js'
import { desktopTools } from './tools/desktop.js'
import { browserTools, ManagedBrowser } from './tools/browser.js'
import { macTools } from './tools/mac.js'
import { rememberTool } from './tools/memory.js'
import { yourBrowserTools } from './tools/your-browser.js'
import { TaskRunner } from './loop/task-runner.js'
import { ClaudeCodePlanner } from './model/claude-code-planner.js'
import { runBench } from './bench.js'
import { createOsAdapter } from '../os/index.js'
import type { HostToRuntime, LogEntry, RuntimeToHost } from '../shared/protocol.js'
import type { PetState, TaskState } from '../shared/types.js'

const helperPath = process.env.KIBU_HELPER_PATH ?? ''
const profileDir = process.env.KIBU_BROWSER_PROFILE ?? join(process.cwd(), '.kibu-browser')
const downloadDir = process.env.KIBU_DOWNLOAD_DIR ?? join(process.cwd(), 'downloads')

function send(msg: RuntimeToHost): void {
  process.send?.(msg)
}

const os = createOsAdapter(helperPath)
const browser = new ManagedBrowser(profileDir, downloadDir, (level, message) =>
  send({ type: 'log', entry: { taskId: 'runtime', at: Date.now(), level, source: 'browser', message } })
)

const registry = new ToolRegistry()
registry.registerAll([...documentTools, ...brainTools, ...fileTools, ...shellTools, ...userTools, ...desktopTools, ...browserTools, ...macTools, ...yourBrowserTools, rememberTool])

let runner: TaskRunner | null = null
const pendingBrain = new Map<string, { resolve: (state: BrainSnapshot) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
function requestBrain(taskId: string, input: BrainRequest): Promise<BrainSnapshot> {
  return new Promise((resolve, reject) => {
    const callId = randomUUID()
    const timer = setTimeout(() => { pendingBrain.delete(callId); reject(new Error('Workspace response timed out. Check the workspace before retrying.')) }, 15000)
    pendingBrain.set(callId, { resolve, reject, timer })
    send({ type: 'tool-call', callId, taskId, tool: 'brain', input })
  })
}

/**
 * Only one task may drive the real desktop at a time. The host owns the
 * session so it can show the indicator and honour the global stop shortcut.
 */
const desktopHooks = {
  claimDesktop(taskId: string, reason: string): Promise<void> {
    send({ type: 'log', entry: { taskId, at: Date.now(), level: 'info', source: 'desktop', message: `taking control: ${reason}` } })
    send({ type: 'desktop-claim', taskId, reason })
    return Promise.resolve()
  },
  releaseDesktop(taskId: string): void {
    send({ type: 'desktop-release', taskId })
  }
}

async function startTask(msg: Extract<HostToRuntime, { type: 'start' }>): Promise<void> {
  if (runner && !['succeeded', 'failed', 'cancelled'].includes(runner.task.status)) {
    send({ type: 'error', message: 'a task is already running', fatal: false })
    return
  }
  const droppedPaths = (msg.task as TaskState & { droppedPaths?: string[] }).droppedPaths ?? []
  runner = new TaskRunner(
    msg.task,
    {
      os,
      brain: (request) => requestBrain(msg.task.id, request),
      browser,
      registry,
      model: msg.model,
      apiKey: msg.apiKey,
      jevEnabled: process.env.KIBU_JEV !== '0',
      jevApiKey: msg.jevApiKey,
      workflowsEnabled: msg.workflowsEnabled,
      ...(msg.useClaudeCode
        ? { createPlanner: (): ClaudeCodePlanner => new ClaudeCodePlanner({ model: msg.model.claudeCode }) }
        : {}),
      frontWindow: msg.frontWindow,
      previousApp: msg.previousApp ?? null,
      prefetchContext: true,
      memories: msg.memories ?? [],
      memory: msg.memory ?? { enabled: false, learn: false },
      confirmEveryAction: msg.confirmEveryAction,
      previousTurn: msg.previousTurn,
      droppedPaths
    },
    {
      onUpdate: (task: TaskState) => send({ type: 'task-update', task }),
      onPetState: (state: PetState) => send({ type: 'pet-state', state }),
      onLog: (entry: LogEntry) => send({ type: 'log', entry }),
      onMemory: (event) => send({ type: 'memory', event }),
      ...desktopHooks
    }
  )
  const finished = await runner.run()
  send({ type: 'task-update', task: finished })
}

process.on('message', (raw: HostToRuntime) => {
  switch (raw.type) {
    case 'tool-result': {
      const pending = pendingBrain.get(raw.callId)
      if (pending) {
        clearTimeout(pending.timer); pendingBrain.delete(raw.callId)
        if (raw.ok) pending.resolve(raw.value as BrainSnapshot)
        else pending.reject(new Error(raw.error ?? 'Workspace request failed.'))
      }
      break
    }
    case 'start':
      void startTask(raw)
      break
    case 'pause':
      runner?.pause()
      break
    case 'resume':
      runner?.resume()
      break
    case 'cancel':
      runner?.cancel()
      break
    case 'answer':
      runner?.answer(raw.answer)
      break
    case 'bench':
      void runBench(raw.jevApiKey, raw.model)
        .then((rows) => send({ type: 'bench-result', rows }))
        .catch((err: unknown) =>
          send({ type: 'error', message: `bench failed: ${err instanceof Error ? err.message : String(err)}`, fatal: false })
        )
      break
    case 'shutdown':
      void shutdown()
      break
  }
})

async function shutdown(): Promise<void> {
  runner?.cancel()
  await browser.close().catch(() => {})
  await os.dispose().catch(() => {})
  process.exit(0)
}

process.on('uncaughtException', (err) => {
  send({ type: 'error', message: `runtime crashed: ${err.message}`, fatal: true })
  // Let the host decide whether to restart; exiting loudly beats limping on.
  setTimeout(() => process.exit(1), 100)
})

process.on('unhandledRejection', (reason) => {
  send({ type: 'error', message: `unhandled rejection in runtime: ${String(reason)}`, fatal: false })
})

send({ type: 'ready' })
