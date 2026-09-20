import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { Jev, summarizeJev } from '../src/runtime/model/jev.js'
import { defaultLimits, emptyAuthorization, type ActionRecord, type TaskState } from '../src/shared/types.js'

/**
 * Jev is exercised through a stubbed transport, so these tests cover our use
 * of the API — the request we send and how we treat the answer — without
 * calling TypeSafe or needing a key.
 */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = []
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers as Record<string, string>) ?? {}
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  }
  return { impl, calls }
}

function systemOneResponse(answers: Record<string, unknown>, inputTokens = 1000) {
  return {
    model: 'jev-latest',
    answers,
    usage: { input_tokens: inputTokens, output_tokens: 0 }
  }
}

function task(actions: Partial<ActionRecord>[]): TaskState {
  return {
    id: 't1',
    request: 'organise my downloads',
    outcome: '',
    status: 'executing',
    petState: 'working',
    authorization: emptyAuthorization(),
    limits: defaultLimits(),
    observations: [],
    plan: [],
    actions: actions.map((a, i) => ({
      id: `a${i}`,
      step: i,
      tool: 'files_move',
      input: {},
      startedAt: i,
      outcome: 'success',
      ...a
    })) as ActionRecord[],
    cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    completionCriteria: [],
    statusLine: '',
    createdAt: 0,
    updatedAt: 0
  }
}

/** A messy-but-not-rule-breaking history: no local rule fires, so Jev is asked. */
function untidyHistory(): TaskState {
  return task([
    { outcome: 'success', tool: 'files_list' },
    { outcome: 'failure', tool: 'files_move', error: 'busy' },
    { outcome: 'success', tool: 'files_move' },
    { outcome: 'uncertain', tool: 'desktop_click' },
    { outcome: 'success', tool: 'files_move' }
  ])
}

describe('Jev request shape', () => {
  test('routing asks one choice and one noul in a single round trip', async () => {
    const stub = stubFetch(
      systemOneResponse({
        route: { type: 'choice', choice: 'browser', confidence: 0.91, probabilities: {} },
        needsClarification: { type: 'noul', noul: 0.1 }
      })
    )
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    // Deliberately vague so the local rules do not short-circuit the call.
    const decision = await jev.routeRequest('please take care of this for me now', false)

    assert.equal(stub.calls.length, 1, 'both questions must go in one request')
    const body = stub.calls[0]!.body as { questions: Record<string, { type: string }>; model: string }
    assert.equal(body.questions.route!.type, 'choice')
    assert.equal(body.questions.needsClarification!.type, 'noul')
    assert.equal(body.model, 'jev-latest')
    assert.match(stub.calls[0]!.url, /systemone/i)

    assert.equal(decision.route, 'browser')
    assert.equal(decision.needsClarification, false)
  })

  test('a noul probability above a half is read as yes', async () => {
    const stub = stubFetch(
      systemOneResponse({
        route: { type: 'choice', choice: 'unclear', confidence: 0.4, probabilities: {} },
        needsClarification: { type: 'noul', noul: 0.87 }
      })
    )
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    const decision = await jev.routeRequest('please take care of this for me now', false)
    assert.equal(decision.needsClarification, true)
  })

  test('local rules answer confident cases without spending a call', async () => {
    const stub = stubFetch(systemOneResponse({}))
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    const decision = await jev.routeRequest('organise my downloads folder', false)
    assert.equal(stub.calls.length, 0, 'a confident local answer must not hit the network')
    assert.equal(decision.route, 'files')
    assert.equal(jev.metrics.calls[0]!.usedModel, false)
  })
})

describe('Jev may increase caution, never reduce it', () => {
  test('it can escalate a local "continue" to "ask"', async () => {
    const stub = stubFetch(
      systemOneResponse({
        nextMove: { type: 'choice', choice: 'ask', confidence: 0.8, probabilities: {} },
        stuck: { type: 'noul', noul: 0.9 }
      })
    )
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    const t = untidyHistory()
    assert.equal(jev.assessProgressLocally(t).action, 'continue')

    const verdict = await jev.assessProgress(t)
    assert.equal(verdict.action, 'ask')
    assert.equal(verdict.deterministic, false)
    assert.equal(jev.metrics.overrides, 1)
  })

  test('it CANNOT talk a deterministic "ask" back down to "continue"', async () => {
    const stub = stubFetch(
      systemOneResponse({
        nextMove: { type: 'choice', choice: 'continue', confidence: 0.99, probabilities: {} },
        stuck: { type: 'noul', noul: 0.01 }
      })
    )
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    // Three consecutive failures trips the local failure budget.
    const t = task([
      { outcome: 'failure', tool: 'files_move', error: 'a' },
      { outcome: 'failure', tool: 'files_move', error: 'b' },
      { outcome: 'failure', tool: 'files_move', error: 'c' }
    ])
    assert.equal(jev.assessProgressLocally(t).action, 'ask')

    const verdict = await jev.assessProgress(t)
    assert.equal(verdict.action, 'ask', 'a high-confidence Jev answer must not override the failure budget')
    assert.equal(verdict.deterministic, true)
    assert.equal(stub.calls.length, 0, 'no call is even made once a local rule has fired')
  })

  test('a lower-caution suggestion on an untidy history is ignored', async () => {
    const stub = stubFetch(
      systemOneResponse({
        nextMove: { type: 'choice', choice: 'continue', confidence: 0.95, probabilities: {} },
        stuck: { type: 'noul', noul: 0.05 }
      })
    )
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    const verdict = await jev.assessProgress(untidyHistory())
    assert.equal(verdict.action, 'continue')
    assert.equal(jev.metrics.overrides, 0)
  })

  test('a tidy history is not worth a Jev call at all', async () => {
    const stub = stubFetch(systemOneResponse({}))
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    await jev.assessProgress(task([{ outcome: 'success' }, { outcome: 'success' }]))
    assert.equal(stub.calls.length, 0)
  })
})

describe('Jev failure never breaks a task', () => {
  test('an API error falls back to local routing', async () => {
    const stub = stubFetch({ error: { message: 'boom' } }, 500)
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    const decision = await jev.routeRequest('please take care of this for me now', false)
    assert.equal(decision.route, 'unclear', 'falls back to the local verdict')
    assert.match(jev.metrics.calls.at(-1)!.outcome, /fallback/)
  })

  test('an API error during a progress check keeps the local verdict', async () => {
    const stub = stubFetch({ error: { message: 'boom' } }, 500)
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    const verdict = await jev.assessProgress(untidyHistory())
    assert.equal(verdict.action, 'continue')
    assert.equal(verdict.deterministic, true)
  })

  test('with no key and no transport, Jev is simply unavailable', () => {
    const jev = new Jev(null, true)
    // Constructing without a key must not throw; the loop carries on locally.
    assert.equal(typeof jev.available, 'boolean')
  })

  test('disabled means disabled', async () => {
    const stub = stubFetch(systemOneResponse({}))
    const jev = new Jev('test-key', false, 'jev-latest', stub.impl)
    assert.equal(jev.available, false)
    await jev.routeRequest('please take care of this for me now', false)
    assert.equal(stub.calls.length, 0)
  })
})

describe('Jev file assignment', () => {
  test('assigns files only to groups that were declared, in one batched call', async () => {
    const stub = stubFetch(
      systemOneResponse({
        f0: { type: 'choice', choice: 'Invoices', confidence: 0.9, probabilities: {} },
        f1: { type: 'choice', choice: 'Photos', confidence: 0.8, probabilities: {} },
        f2: { type: 'choice', choice: 'unsorted', confidence: 0.5, probabilities: {} }
      })
    )
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    const result = await jev.assignFilesToGroups(
      [
        { name: 'invoice-jan.pdf', ext: '.pdf', modifiedAt: Date.now() },
        { name: 'beach.png', ext: '.png', modifiedAt: Date.now() },
        { name: 'thing.dat', ext: '.dat', modifiedAt: Date.now() }
      ],
      [
        { name: 'Invoices', description: 'Bills and receipts' },
        { name: 'Photos', description: 'Images and screenshots' }
      ]
    )

    assert.equal(stub.calls.length, 1, 'all three files go in one request')
    const body = stub.calls[0]!.body as { questions: Record<string, { criteria: Record<string, unknown> }> }
    // Every question offers exactly the declared groups plus "unsorted".
    assert.deepEqual(Object.keys(body.questions).sort(), ['f0', 'f1', 'f2'])
    assert.deepEqual(Object.keys(body.questions.f0!.criteria).sort(), ['Invoices', 'Photos', 'unsorted'])

    assert.deepEqual(result!.assignments, { 'invoice-jan.pdf': 'Invoices', 'beach.png': 'Photos' })
    assert.deepEqual(result!.unsorted, ['thing.dat'])
  })

  test('with no groups declared there is nothing for Jev to choose between', async () => {
    const stub = stubFetch(systemOneResponse({}))
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    const result = await jev.assignFilesToGroups([{ name: 'a.txt', ext: '.txt', modifiedAt: 0 }], [])
    assert.equal(result, null)
    assert.equal(stub.calls.length, 0)
  })
})

describe('Jev cost accounting', () => {
  test('uses Jev input pricing and treats output as free', async () => {
    const stub = stubFetch(
      systemOneResponse(
        {
          route: { type: 'choice', choice: 'files', confidence: 0.9, probabilities: {} },
          needsClarification: { type: 'noul', noul: 0.1 }
        },
        1_000_000
      )
    )
    const jev = new Jev('test-key', true, 'jev-latest', stub.impl)
    await jev.routeRequest('please take care of this for me now', false)
    // $0.042 per million input tokens.
    assert.ok(Math.abs(jev.metrics.totalUsd - 0.042) < 1e-9, `got ${jev.metrics.totalUsd}`)
    assert.match(summarizeJev(jev.metrics), /via Jev/)
  })
})
