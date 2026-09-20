import { test } from 'node:test'
import assert from 'node:assert/strict'
import { understand, extensionsFor, bytesFor, routeFor } from '../src/runtime/model/understand.js'
import type { Jev } from '../src/runtime/model/jev.js'

/** A Jev that is not there, so these all exercise the free local path. */
const noJev = { ask: async () => null } as unknown as Jev
/** A Jev that records what it was asked. */
function spy(answers: Record<string, unknown> = {}): { jev: Jev; calls: number } {
  const state = { calls: 0 }
  return {
    jev: {
      ask: async () => {
        state.calls++
        return answers
      }
    } as unknown as Jev,
    get calls() {
      return state.calls
    }
  }
}

test('plurals do not need their own entry', async () => {
  // "movie" was listed and "movies" was not, so asking for movies searched
  // for the literal word and found nothing.
  for (const request of ['find movies', 'find a movie', 'find my films', 'show me videos']) {
    const read = await understand(request, noJev, false)
    assert.equal(read.kind, 'video', request)
    assert.ok(extensionsFor(read.kind).includes('.mp4'))
  }
})

test('size is understood, and turns into a real filter', async () => {
  for (const request of ['find big files', 'show me the biggest files eating my space', 'what is hogging storage']) {
    const read = await understand(request, noJev, false)
    assert.equal(read.size === 'big' || read.size === 'huge', true, request)
  }
  assert.equal(bytesFor('big'), 100 * 1024 * 1024)
  assert.equal(bytesFor('any'), null)
})

test('a plain file request costs nothing', async () => {
  const s = spy()
  const read = await understand('find my aadhar card', s.jev, false)
  assert.equal(s.calls, 0, 'local rules were certain, so Jev was not asked')
  assert.equal(read.action, 'find')
  assert.equal(read.source, 'local')
})

test('naming a site wins over any file-ish verb in the sentence', async () => {
  // Both "open" and "search" appear. Picking whichever verb came first in a
  // list is how this ended up searching Downloads for a YouTube video.
  const read = await understand('open youtube and search for a good video', noJev, false)
  assert.equal(read.action, 'web')
  assert.equal(routeFor(read).route, 'browser')
})

test('a domain shape is recognised without listing top-level domains', async () => {
  assert.equal((await understand('open bunkr.cr and tell me what it is', noJev, false)).action, 'web')
  // A filename is host-shaped too, and is not a website.
  assert.equal((await understand('open report.pdf', noJev, false)).action, 'open')
})

test('two verbs pulling different ways go to Jev rather than being guessed', async () => {
  const s = spy({ action: { choice: 'find', confidence: 0.8 } })
  await understand('sort out whether to rename or find that thing', s.jev, false)
  assert.equal(s.calls, 1)
})

test('make-and-open is one job, not two competing ones', async () => {
  const s = spy()
  const read = await understand('create a folder called automaton in dev and open it in zed', s.jev, false)
  assert.equal(s.calls, 0, 'a compound command is still certain')
  assert.equal(read.action, 'make')
})

test('a request with no verb at all is exactly what Jev is for', async () => {
  const s = spy({ action: { choice: 'find', confidence: 0.7 }, kind: { choice: 'video' } })
  const read = await understand('any movies to watch?', s.jev, false)
  assert.equal(s.calls, 1)
  assert.equal(read.action, 'find')
  assert.equal(read.kind, 'video')
})

test('a malformed reply never throws mid-task', async () => {
  const s = spy({ action: 'nonsense', kind: null })
  const read = await understand('do something with movies', s.jev, false)
  assert.equal(read.action, 'other')
  assert.ok(read.kind)
})
