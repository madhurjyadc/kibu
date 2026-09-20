import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'

import { ManagedBrowser } from '../src/runtime/tools/browser.js'
import {
  browserNavigate,
  browserInspectPage,
  browserFill,
  browserClick,
  browserDownload
} from '../src/runtime/tools/browser.js'
import type { ToolContext } from '../src/runtime/tools/registry.js'
import { defaultLimits, emptyAuthorization, type TaskState } from '../src/shared/types.js'

process.env.KIBU_BROWSER_HEADLESS = '1'

let server: Server
let baseUrl: string
let dir: string
let browser: ManagedBrowser
let submitted: Record<string, string> | null = null

const PAGE = `<!doctype html><html><body>
  <h1>Expense claim</h1>
  <form method="GET" action="/submit">
    <label>Full name <input name="fullName" id="fullName"></label>
    <label>Amount <input name="amount" id="amount"></label>
    <button type="submit" id="go">Submit claim</button>
  </form>
  <a id="dl" href="/receipt.txt" download="receipt.txt">Download receipt</a>
</body></html>`

function ctx(task: TaskState): ToolContext {
  return {
    task,
    os: {} as ToolContext['os'],
    browser,
    log: () => {},
    progress: () => {},
    observe: (o) => {
      const full = { ...o, id: 'o', observedAt: Date.now() }
      task.observations.push(full)
      return full
    },
    ask: async () => ({ optionId: 'continue' }),
    checkpoint: async () => {},
    claimDesktop: async () => {},
    releaseDesktop: () => {}
  }
}

function makeTask(): TaskState {
  const auth = emptyAuthorization()
  auth.origins = ['*']
  return {
    id: 'browser-task',
    request: 'fill the form and download the receipt',
    outcome: '',
    status: 'executing',
    petState: 'working',
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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kibu-browser-'))
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/submit') {
      submitted = Object.fromEntries(url.searchParams.entries())
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><h1>Claim received</h1></body></html>')
      return
    }
    if (url.pathname === '/receipt.txt') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="receipt.txt"'
      })
      res.end('RECEIPT-12345')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  browser = new ManagedBrowser(join(dir, 'profile'), join(dir, 'downloads'), () => {})
})

after(async () => {
  await browser.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(dir, { recursive: true, force: true })
})

describe('managed browser workflow', () => {
  test('navigates, and verification confirms the landed origin', async (t) => {
    const task = makeTask()
    const c = ctx(task)
    const out = await browserNavigate.execute({ url: baseUrl, waitUntil: 'domcontentloaded' }, c)
    assert.equal((out.result as { status: number }).status, 200)
    const v = await browserNavigate.verify!({ url: baseUrl, waitUntil: 'domcontentloaded' }, out, c)
    assert.equal(v.verified, true)
  })

  test('inspecting the page yields usable element references and untrusted text', async () => {
    const task = makeTask()
    const c = ctx(task)
    await browserNavigate.execute({ url: baseUrl, waitUntil: 'domcontentloaded' }, c)
    const out = await browserInspectPage.execute({}, c)
    const result = out.result as {
      elements: { ref: string; tag: string; label: string }[]
      untrustedPageText: string
    }
    assert.ok(result.elements.length >= 3, 'form controls should be discovered')
    assert.ok(result.elements.some((e) => e.tag === 'input'))
    assert.ok(result.elements.some((e) => e.tag === 'button'))
    // Page text is surfaced under a name that marks it as untrusted data.
    assert.match(result.untrustedPageText, /Expense claim/)
    assert.equal(task.observations.length, 1)
  })

  test('fills fields and independently verifies the value took', async () => {
    const task = makeTask()
    const c = ctx(task)
    await browserNavigate.execute({ url: baseUrl, waitUntil: 'domcontentloaded' }, c)
    const snap = (await browserInspectPage.execute({}, c)).result as {
      elements: { ref: string; label: string; tag: string }[]
    }
    const nameRef = snap.elements.find((e) => e.label.includes('Full name'))!.ref

    const out = await browserFill.execute({ ref: nameRef, value: 'Ada Lovelace' }, c)
    const v = await browserFill.verify!({ ref: nameRef, value: 'Ada Lovelace' }, out, c)
    assert.equal(v.verified, true, v.detail)
  })

  test('submits the form and the server really receives the values', async () => {
    submitted = null
    const task = makeTask()
    const c = ctx(task)
    await browserNavigate.execute({ url: baseUrl, waitUntil: 'domcontentloaded' }, c)
    const snap = (await browserInspectPage.execute({}, c)).result as {
      elements: { ref: string; label: string; tag: string }[]
    }
    const refFor = (needle: string): string =>
      snap.elements.find((e) => e.label.toLowerCase().includes(needle))!.ref

    await browserFill.execute({ ref: refFor('full name'), value: 'Ada Lovelace' }, c)
    await browserFill.execute({ ref: refFor('amount'), value: '42.50' }, c)
    await browserClick.execute({ ref: refFor('submit claim'), description: 'submit the claim' }, c)

    assert.deepEqual(submitted, { fullName: 'Ada Lovelace', amount: '42.50' })
  })

  test('downloads a file and verifies it exists on disk with content', async () => {
    const task = makeTask()
    const c = ctx(task)
    await browserNavigate.execute({ url: baseUrl, waitUntil: 'domcontentloaded' }, c)
    const snap = (await browserInspectPage.execute({}, c)).result as {
      elements: { ref: string; label: string }[]
    }
    const dlRef = snap.elements.find((e) => e.label.includes('Download receipt'))!.ref

    const saveTo = join(dir, 'saved')
    const out = await browserDownload.execute({ ref: dlRef, saveTo, timeoutMs: 30_000 }, c)
    const result = out.result as { path: string; filename: string; bytes: number }

    assert.equal(result.filename, 'receipt.txt')
    assert.ok(result.bytes > 0)
    assert.equal(await fs.readFile(result.path, 'utf8'), 'RECEIPT-12345')

    const v = await browserDownload.verify!({ ref: dlRef, timeoutMs: 30_000 }, out, c)
    assert.equal(v.verified, true, v.detail)
    // Evidence the user can actually open.
    assert.equal(out.evidence?.[0]?.value, result.path)
  })

  test('a reference from a previous page is rejected rather than mis-clicked', async () => {
    const task = makeTask()
    const c = ctx(task)
    await browserNavigate.execute({ url: baseUrl, waitUntil: 'domcontentloaded' }, c)
    await browserInspectPage.execute({}, c)
    // Navigate somewhere with none of those elements.
    await browserNavigate.execute({ url: `${baseUrl}/submit`, waitUntil: 'domcontentloaded' }, c)
    await assert.rejects(
      () => browserClick.execute({ ref: 'e1', description: 'stale' }, c),
      /no longer on the page/
    )
  })
})
