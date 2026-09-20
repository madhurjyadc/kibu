import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Jev } from '../src/runtime/model/jev.js'
import { routeToWorkflow } from '../src/runtime/workflows/index.js'

/** With no key, Jev falls back to the local keyword rules — what we want to test. */
const local = new Jev(null, false)
const ctx = { ask: async () => null, log: () => {} }

test('a filename is not mistaken for a domain', async () => {
  // "report.pdf" is host-shaped but is plainly a file.
  const decision = await local.routeRequest('open report.pdf for me', false)
  assert.equal(decision.route, 'files')
})

test('naming a website routes to the browser, with no Jev call needed', async () => {
  for (const request of [
    'open youtube for me and search for good video to watch',
    'go to netflix and see what is new',
    'open bunkr.cr and tell me what that page is',
    'search the web for flight prices'
  ]) {
    const decision = await local.routeRequest(request, false)
    assert.equal(decision.route, 'browser', request)
  }
})

test('a web request never reaches a file workflow, however file-ish the wording', async () => {
  // "search for" matches the find workflow's keywords. The route has to win,
  // because no list of site names can ever be complete.
  const request = 'open youtube for me and search for good video to watch'
  const decision = await local.routeRequest(request, false)
  const match = await routeToWorkflow(request, [], ctx, decision.route)
  assert.equal(match, null)
})

test('a genuine file request still takes the fast path', async () => {
  const request = 'tidy up my downloads folder'
  const decision = await local.routeRequest(request, false)
  assert.equal(decision.route, 'files')
  const match = await routeToWorkflow(request, [], ctx, decision.route)
  assert.equal(match?.workflow.id, 'organize_folder')
})

test('files dropped on the pet count as a file request even with no wording', async () => {
  const match = await routeToWorkflow('sort these out', ['/tmp/a.pdf'], ctx, 'unclear')
  assert.ok(match, 'dropped files are an unambiguous signal')
})

test('a request mixing the web and files goes to the planner, not a workflow', async () => {
  const request = 'find the youtube video I downloaded'
  const decision = await local.routeRequest(request, false)
  assert.equal(decision.route, 'mixed', 'both signals present')
  assert.equal(await routeToWorkflow(request, [], ctx, decision.route), null)
})

test('an unsure request is left for Jev rather than guessed at locally', async () => {
  const decision = await local.routeRequest('deal with that thing from earlier', false)
  // Below the 0.85 bar is what sends it to Jev when a key is configured.
  assert.ok(decision.confidence < 0.85, `confidence was ${decision.confidence}`)
})

test('personal document searches reach local retrieval without a model or clarification', async () => {
  for (const request of ['find my aadhar card in my pc', 'where is my Aadhaar', 'find my passport', 'locate my CV', 'find my driving licence', 'find my आधार card']) {
    const decision = await local.routeRequest(request, false)
    assert.equal(decision.route, 'files', request)
    assert.equal(decision.needsClarification, false)
    const match = await routeToWorkflow(request, [], ctx, decision.route)
    assert.equal(match?.workflow.id, 'find_files', request)
  }
})

test('a command request reaches the command workflow, not the file finder', async () => {
  const request = 'create a new folder named automaton inside the dev folder and open it in zed editor'
  const decision = await local.routeRequest(request, false)
  const match = await routeToWorkflow(request, [], ctx, decision.route)
  assert.equal(match?.workflow.id, 'run_command')
})

test('"open X in Y" works even when the wording gives no route signal', async () => {
  const decision = await local.routeRequest('open dev in zed', false)
  // No keyword lands, so this is exactly the case Jev is for. With no key the
  // route stays unclear, and the command workflow is still eligible there.
  const match = await routeToWorkflow('open dev in zed', [], ctx, decision.route)
  assert.equal(match?.workflow.id, 'run_command')
})
