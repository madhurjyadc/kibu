import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { TaskRunner, type RunnerDeps } from '../src/runtime/loop/task-runner.js'
import { ToolRegistry } from '../src/runtime/tools/registry.js'
import { fileTools } from '../src/runtime/tools/files.js'
import { userTools } from '../src/runtime/tools/user.js'
import { checkScopes } from '../src/runtime/authorization.js'
import { defaultLimits, emptyAuthorization, type TaskState, type UserQuestion } from '../src/shared/types.js'
import { DEFAULT_MODEL_CONFIG } from '../src/shared/protocol.js'

/**
 * A job that will need permission asks once before it starts. Workflows are
 * off and the planner finishes at once, so nothing here touches real files.
 */
async function run(request: string, choice: 'all' | 'each'): Promise<{ task: TaskState; questions: UserQuestion[] }> {
  const registry = new ToolRegistry()
  registry.registerAll([...fileTools, ...userTools])
  const task: TaskState = {
    id: 't', request, outcome: '', status: 'pending', petState: 'idle',
    authorization: { ...emptyAuthorization(), capabilities: ['user.interact', 'files.read'] }, limits: defaultLimits(),
    observations: [], plan: [], actions: [], cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    completionCriteria: [], statusLine: '', createdAt: Date.now(), updatedAt: Date.now()
  }
  const deps: RunnerDeps = {
    os: { supports: () => false } as unknown as RunnerDeps['os'],
    browser: { isOpen: () => false, close: async () => {} } as unknown as RunnerDeps['browser'],
    registry, model: DEFAULT_MODEL_CONFIG, apiKey: null, jevEnabled: false, jevApiKey: null, workflowsEnabled: false,
    droppedPaths: [], frontWindow: null, previousTurn: null, confirmEveryAction: false,
    createPlanner: () => ({
      seed() {}, addToolResults() {}, addNote() {},
      async propose() { return { calls: [{ id: 'c', name: 'finish', input: { success: true, headline: 'done' } }], text: '', stopReason: 'tool_use', usd: 0, inputTokens: 1, outputTokens: 1 } }
    })
  }
  const questions: UserQuestion[] = []
  const runner: TaskRunner = new TaskRunner(task, deps, {
    onUpdate(t) {
      const q = t.question
      if (q && !questions.some((x) => x.id === q.id)) { questions.push(q); queueMicrotask(() => runner.answer({ questionId: q.id, optionId: choice })) }
    },
    onPetState() {}, onLog() {}, async claimDesktop() {}, releaseDesktop() {}
  })
  return { task: await runner.run(), questions }
}

test('tidying a named folder asks once, up front, and "Allow all" covers the whole folder', async () => {
  const { task, questions } = await run('organize my desktop folder', 'all')
  assert.equal(questions.length, 1)
  assert.match(questions[0]!.prompt, /Before I start/)
  assert.match(questions[0]!.prompt, /Change files in Desktop/)
  const desktopFile = join(homedir(), 'Desktop', 'Screenshot 1.png')
  assert.equal(checkScopes(task.authorization, [{ kind: 'write', path: desktopFile }]).allowed, true)
})

test('"Ask me each time" grants nothing up front', async () => {
  const { task } = await run('organize my desktop folder', 'each')
  assert.equal(task.authorization.writeRoots.length, 0)
})

test('a question, or a search, is not interrupted by a permission prompt', async () => {
  for (const request of ['what is the capital of France?', 'find my tax return pdf']) {
    const { questions } = await run(request, 'all')
    assert.equal(questions.length, 0, request)
  }
})
