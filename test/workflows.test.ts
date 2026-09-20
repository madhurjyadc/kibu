import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { TaskRunner, type RunnerDeps, type RunnerHooks } from '../src/runtime/loop/task-runner.js'
import { ToolRegistry } from '../src/runtime/tools/registry.js'
import { fileTools } from '../src/runtime/tools/files.js'
import { userTools } from '../src/runtime/tools/user.js'
import { defaultLimits, emptyAuthorization, type TaskState } from '../src/shared/types.js'
import { DEFAULT_MODEL_CONFIG } from '../src/shared/protocol.js'
import { candidateProjectGroups, typeGroupFor } from '../src/runtime/workflows/common.js'
import { SCHEMES } from '../src/runtime/workflows/rename.js'
import { WORKFLOWS } from '../src/runtime/workflows/index.js'

const registry = new ToolRegistry()
registry.registerAll([...fileTools, ...userTools])

let root: string

/**
 * A Jev stub that answers by question name, so a workflow can be driven
 * end to end without a network. Records every request for inspection.
 */
function jevStub(answerFor: (questionNames: string[], body: any) => Record<string, unknown>) {
  const requests: any[] = []
  const impl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    requests.push(body)
    const answers = answerFor(Object.keys(body.questions ?? {}), body)
    return new Response(
      JSON.stringify({ model: 'jev-latest', answers, usage: { input_tokens: 500, output_tokens: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
  return { impl, requests }
}

const choiceAnswer = (value: string, confidence = 0.9) => ({
  type: 'choice',
  choice: value,
  confidence,
  probabilities: {}
})

interface Harness {
  runner: TaskRunner
  /** True if the planning model was ever asked to propose — i.e. an API call. */
  plannerUsed: () => boolean
  questionsAsked: string[]
}

function harness(
  task: TaskState,
  droppedPaths: string[],
  jevFetch: RunnerDeps['jevFetch'],
  answerUser: (prompt: string) => { optionId: string | null; text?: string },
  options: { noPlannerAvailable?: boolean } = {}
): Harness {
  let plannerWasUsed = false
  const questionsAsked: string[] = []

  const hooks: RunnerHooks = {
    onUpdate: (t) => {
      if (t.question) {
        const q = t.question
        questionsAsked.push(q.prompt)
        queueMicrotask(() => runner.answer({ questionId: q.id, ...answerUser(q.prompt) }))
      }
    },
    onPetState: () => {},
    onLog: () => {},
    claimDesktop: async () => {},
    releaseDesktop: () => {}
  }

  const deps: RunnerDeps = {
    os: { supports: () => false } as unknown as RunnerDeps['os'],
    // A browser that is simply never open: these tests do not touch the web.
    browser: { isOpen: () => false, close: async () => {}, page: async () => { throw new Error('no browser in this test') } } as unknown as RunnerDeps['browser'],
    registry,
    model: DEFAULT_MODEL_CONFIG,
    // No Anthropic key at all.
    apiKey: null,
    jevEnabled: true,
    jevApiKey: 'test-jev-key',
    jevFetch,
    workflowsEnabled: true,
    droppedPaths,
    frontWindow: null,
    previousTurn: null,
    confirmEveryAction: false,
    // Proposing is the network call. If a workflow handles the task, this
    // must never fire. Omitting createPlanner entirely models a user with no
    // Anthropic key at all.
    ...(options.noPlannerAvailable
      ? {}
      : {
          createPlanner: () => ({
            seed: () => {},
            addToolResults: () => {},
            addNote: () => {},
            propose: async () => {
              plannerWasUsed = true
              throw new Error('the planning model must not be used for this task')
            }
          })
        })
  }

  const runner = new TaskRunner(task, deps, hooks)
  return { runner, plannerUsed: () => plannerWasUsed, questionsAsked }
}

function makeTask(request: string, roots: string[]): TaskState {
  const auth = emptyAuthorization()
  auth.readRoots = roots
  auth.writeRoots = roots
  auth.capabilities = ['files.read', 'files.write', 'user.interact']
  return {
    id: `wf-${Math.random().toString(36).slice(2)}`,
    request,
    outcome: '',
    status: 'pending',
    petState: 'idle',
    authorization: auth,
    limits: defaultLimits(),
    observations: [],
    plan: [],
    actions: [],
    cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    completionCriteria: [],
    statusLine: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'kibu-wf-'))
})
after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

let dir: string
beforeEach(async () => {
  dir = join(root, `case-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
})

describe('organising a folder with no planning model', () => {
  test('groups by file type and never constructs the planner', async () => {
    for (const name of ['a.pdf', 'b.pdf', 'photo.png', 'shot.jpg', 'sheet.csv']) {
      await fs.writeFile(join(dir, name), name)
    }

    const jev = jevStub((names) => {
      if (names.includes('strategy')) return { strategy: choiceAnswer('type') }
      return {}
    })

    const task = makeTask('organise this folder', [dir])
    const h = harness(task, [dir], jev.impl, () => ({ optionId: 'approve' }))
    const final = await h.runner.run()

    assert.equal(h.plannerUsed(), false, 'the planning model must never be called')
    assert.equal(final.status, 'succeeded', final.error)

    // The files really moved into type folders.
    assert.deepEqual((await fs.readdir(join(dir, 'Documents'))).sort(), ['a.pdf', 'b.pdf'])
    assert.deepEqual((await fs.readdir(join(dir, 'Images'))).sort(), ['photo.png', 'shot.jpg'])
    assert.deepEqual(await fs.readdir(join(dir, 'Spreadsheets')), ['sheet.csv'])

    // Only one Jev call was needed: assignment by type is pure local code.
    assert.equal(jev.requests.length, 1)
    assert.equal(final.cost.usd, 0, 'no planning-model tokens were spent')
    assert.ok(final.summary!.undoable)
  })

  test('the user is shown a preview and cancelling moves nothing', async () => {
    for (const name of ['x.pdf', 'y.png']) await fs.writeFile(join(dir, name), name)
    const jev = jevStub(() => ({ strategy: choiceAnswer('type') }))

    const task = makeTask('tidy this up', [dir])
    const h = harness(task, [dir], jev.impl, () => ({ optionId: 'reject' }))
    const final = await h.runner.run()

    assert.equal(final.status, 'failed')
    assert.match(h.questionsAsked[0]!, /Move 2 files/)
    assert.deepEqual((await fs.readdir(dir)).sort(), ['x.pdf', 'y.png'], 'nothing may move after a cancel')
  })

  test('groups by project using names derived from the filenames', async () => {
    for (const name of ['acme-invoice.pdf', 'acme-notes.txt', 'zephyr-plan.pdf', 'zephyr-budget.csv']) {
      await fs.writeFile(join(dir, name), name)
    }

    const jev = jevStub((names, body) => {
      if (names.includes('strategy')) return { strategy: choiceAnswer('project') }
      // Assignment: echo back whichever project the filename mentions.
      const files = body.state.files as { index: number; name: string }[]
      const out: Record<string, unknown> = {}
      for (const f of files) {
        const group = f.name.startsWith('acme') ? 'Acme' : 'Zephyr'
        out[`f${f.index}`] = choiceAnswer(group)
      }
      return out
    })

    const task = makeTask('organise these by project', [dir])
    const h = harness(task, [dir], jev.impl, () => ({ optionId: 'approve' }))
    const final = await h.runner.run()

    assert.equal(h.plannerUsed(), false)
    assert.equal(final.status, 'succeeded', final.error)
    assert.deepEqual((await fs.readdir(join(dir, 'Acme'))).sort(), ['acme-invoice.pdf', 'acme-notes.txt'])
    assert.deepEqual((await fs.readdir(join(dir, 'Zephyr'))).sort(), ['zephyr-budget.csv', 'zephyr-plan.pdf'])

    // Jev was offered only groups that local code derived from the filenames.
    const assignReq = jev.requests.find((r) => Object.keys(r.questions)[0]!.startsWith('f'))
    const criteria = Object.keys(assignReq.questions.f0.criteria).sort()
    assert.deepEqual(criteria, ['Acme', 'Zephyr', 'unsorted'])
  })

  test('a folder with almost nothing in it is left alone', async () => {
    await fs.writeFile(join(dir, 'lonely.txt'), 'x')
    const jev = jevStub(() => ({}))
    const task = makeTask('organise this', [dir])
    const h = harness(task, [dir], jev.impl, () => ({ optionId: 'approve' }))
    const final = await h.runner.run()

    assert.equal(final.status, 'succeeded')
    assert.match(final.summary!.headline, /Nothing to do/)
    assert.deepEqual(await fs.readdir(dir), ['lonely.txt'])
    assert.equal(jev.requests.length, 0, 'an obvious no-op should cost nothing')
  })
})

describe('renaming with no planning model', () => {
  test('applies the scheme Jev picked and verifies each rename', async () => {
    for (const name of ['My Report FINAL.pdf', 'Some  Notes.txt']) {
      await fs.writeFile(join(dir, name), name)
    }
    const jev = jevStub((names) => {
      if (names.includes('workflow')) return { workflow: choiceAnswer('rename_batch') }
      return { scheme: choiceAnswer('kebab') }
    })

    const task = makeTask('rename these files consistently', [dir])
    const h = harness(task, [dir], jev.impl, () => ({ optionId: 'approve' }))
    const final = await h.runner.run()

    assert.equal(h.plannerUsed(), false)
    assert.equal(final.status, 'succeeded', final.error)
    assert.deepEqual((await fs.readdir(dir)).sort(), ['my-report-final.pdf', 'some-notes.txt'])
    // Every rename went through the tool layer, so each one was verified.
    const renames = final.actions.filter((a) => a.tool === 'files_rename')
    assert.equal(renames.length, 2)
    assert.ok(renames.every((r) => r.verification?.verified === true))
  })

  test('already-conforming files are reported as needing no work', async () => {
    await fs.writeFile(join(dir, 'already-fine.txt'), 'x')
    const jev = jevStub((names) => {
      if (names.includes('workflow')) return { workflow: choiceAnswer('rename_batch') }
      return { scheme: choiceAnswer('kebab') }
    })
    const task = makeTask('rename these consistently', [dir])
    const h = harness(task, [dir], jev.impl, () => ({ optionId: 'approve' }))
    const final = await h.runner.run()
    assert.equal(final.status, 'succeeded')
    assert.match(final.summary!.headline, /already follow/)
  })
})

describe('finding a file with no planning model', () => {
  test('finds Aadhaar from natural wording with no planner, model requests, or questions', async () => {
    await fs.writeFile(join(dir, 'e-Aadhaar.pdf'), 'synthetic fixture')
    await fs.writeFile(join(dir, 'birthday-card.pdf'), 'unrelated')
    const task = makeTask('find my aadhar card in my pc', [dir])
    const model = jevStub(() => { throw new Error('No model request should be needed') })
    const h = harness(task, [], model.impl, () => { throw new Error('No question should be needed') }, { noPlannerAvailable: true })
    const final = await h.runner.run()
    assert.equal(final.status, 'succeeded', final.error)
    assert.equal(final.summary?.evidence[0]?.label, 'e-Aadhaar.pdf')
    assert.equal(final.cost.usd, 0)
    assert.equal(model.requests.length, 0)
    assert.deepEqual(h.questionsAsked, [])
  })

  test('reads the sentence in code: no Jev call, no question, just the file', async () => {
    await fs.writeFile(join(dir, 'statement.pdf'), 'pdf')
    await fs.writeFile(join(dir, 'holiday.png'), 'png')

    const jev = jevStub((names) => (names.includes('workflow') ? { workflow: choiceAnswer('find_files') } : {}))
    const task = makeTask('find the statement pdf', [])
    task.authorization.readRoots = [dir]
    const asked: string[] = []
    const h = harness(task, [], jev.impl, (prompt: string) => {
      asked.push(prompt)
      return { optionId: '0' }
    })
    const final = await h.runner.run()

    assert.equal(h.plannerUsed(), false)
    assert.equal(final.status, 'succeeded', final.error)
    assert.equal(final.summary!.headline, '1 match')
    assert.equal(final.summary!.evidence[0]!.label, 'statement.pdf')
    assert.equal(await fs.realpath(final.summary!.evidence[0]!.value), await fs.realpath(join(dir, 'statement.pdf')))
    // The whole point of the rewrite: it does not stop to interrogate.
    assert.deepEqual(asked, [])
    // Filters are parsed locally, so Jev is only ever asked to route.
    assert.ok(!jev.requests.some((r) => r.includes('fileType') || r.includes('location')))
  })

  test('the runners-up come back as evidence rather than as a quiz', async () => {
    for (const name of ['report-jan.pdf', 'report-feb.pdf', 'report-mar.pdf']) {
      await fs.writeFile(join(dir, name), name)
    }
    const jev = jevStub((names) => (names.includes('workflow') ? { workflow: choiceAnswer('find_files') } : {}))
    const task = makeTask('find the report pdf', [])
    task.authorization.readRoots = [dir]
    const asked: string[] = []
    const h = harness(task, [], jev.impl, (prompt: string) => {
      asked.push(prompt)
      return { optionId: '0' }
    })
    const final = await h.runner.run()

    assert.equal(final.status, 'succeeded', final.error)
    assert.deepEqual(asked, [], 'three plausible matches must not become a question')
    assert.ok(final.summary!.evidence.length > 1, 'the alternatives are offered, not asked about')
  })

  test('reports honestly when nothing matches', async () => {
    const jev = jevStub((names) => (names.includes('workflow') ? { workflow: choiceAnswer('find_files') } : {}))
    const task = makeTask('find the wombat spreadsheet', [])
    task.authorization.readRoots = [dir]
    const h = harness(task, [], jev.impl, () => ({ optionId: 'none' }))
    const final = await h.runner.run()

    assert.equal(final.status, 'failed')
    assert.match(final.summary!.headline, /could not find/i)
  })
})

test('a web search is not claimed by the file-finding workflow', () => {
  const find = WORKFLOWS.find((w: { id: string }) => w.id === 'find_files')!
  // Find verbs aimed at the web or at messages belong to the planner.
  assert.equal(find.plausible('open safari and search for flights', []), false)
  assert.equal(find.plausible('search for that thread in my email', []), false)
  assert.equal(find.plausible('find the cheapest flight online', []), false)
  // Genuine file searches still match.
  assert.equal(find.plausible('find the invoice I saved yesterday', []), true)
  assert.equal(find.plausible('where is my tax return pdf', []), true)
})
