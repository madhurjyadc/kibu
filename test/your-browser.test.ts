import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { SCRIPTS, setMacBridge, osascriptBridge, type MacBridge } from '../src/os/macos/scripting.js'
import { yourBrowserTools, yourBrowserClick, yourBrowserType, yourBrowserLook, yourBrowserOpen, isConsequential } from '../src/runtime/tools/your-browser.js'
import { resolveAppName } from '../src/runtime/tools/mac.js'
import { localPlanSetup } from '../src/runtime/model/jev.js'
import { TaskRunner, type RunnerDeps } from '../src/runtime/loop/task-runner.js'
import type { PlannerLike, PlannerProposal } from '../src/runtime/model/planner.js'
import { ToolRegistry, type ToolContext } from '../src/runtime/tools/registry.js'
import { fileTools } from '../src/runtime/tools/files.js'
import { userTools } from '../src/runtime/tools/user.js'
import { browserTools } from '../src/runtime/tools/browser.js'
import { macTools } from '../src/runtime/tools/mac.js'
import { defaultLimits, emptyAuthorization, type TaskState, type UserQuestion } from '../src/shared/types.js'
import { DEFAULT_MODEL_CONFIG } from '../src/shared/protocol.js'

/** A fake Chrome: one tab, a page with a few elements, and a log of what ran in it. */
function fakeChrome(elements: Record<string, { label: string; type?: string; signIn?: boolean }>) {
  const ran: { kind: string; arg: any }[] = []
  let url = 'https://www.youtube.com/'
  const kind = (program: string): string =>
    program.includes('querySelectorAll(sel)') ? 'look' : program.includes('arg.dry') ? 'touch' : program.includes('requestSubmit') ? 'type'
      : program.includes('scrollBy') ? 'scroll' : program.includes("querySelectorAll('video')") ? 'media' : program.includes('readyState') ? 'status' : 'unknown'
  const bridge: MacBridge = {
    async jxa<T>(body: string, input: any): Promise<T> {
      if (body === SCRIPTS.runningApps) return ['Google Chrome', 'Finder'] as T
      if (body === SCRIPTS.newTab) { url = input.url; ran.push({ kind: 'newTab', arg: input }); return { browser: 'Google Chrome' } as T }
      if (body !== SCRIPTS.pageRun) throw new Error('unexpected script')
      const k = kind(input.program)
      const arg = JSON.parse(input.arg)
      ran.push({ kind: k, arg })
      const el = arg.ref ? elements[arg.ref] : undefined
      const result = (() => {
        switch (k) {
          case 'status': return { ready: 'complete', url, title: 'YouTube' }
          case 'look': return { title: 'YouTube', url, items: Object.entries(elements).map(([ref, e]) => ({ ref, tag: 'a', label: e.label })) }
          case 'touch': return el ? { ok: true, label: el.label, isPassword: el.type === 'password', signInForm: !!el.signIn, host: 'www.youtube.com' } : { ok: false, reason: 'stale' }
          case 'type': return el?.type === 'password' || el?.signIn ? { ok: false, reason: 'sign-in' } : { ok: true }
          default: return {}
        }
      })()
      return { browser: 'Google Chrome', result } as T
    },
    async exec(program: string) {
      if (program === 'mdfind') return { stdout: '/Applications/Google Chrome.app\n/Applications/Google Chrome Helper.app\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    }
  }
  return { bridge, ran }
}

function context(answers: string[] = []): { ctx: ToolContext; asked: UserQuestion[]; claims: string[] } {
  const asked: UserQuestion[] = []
  const claims: string[] = []
  const task = { authorization: emptyAuthorization() } as TaskState
  const ctx = {
    task,
    progress: () => {},
    observe: (o: unknown) => o,
    ask: async (q: UserQuestion) => { asked.push(q); return { optionId: answers.shift() ?? null } },
    claimDesktop: async (reason: string) => { claims.push(reason) },
    log: () => {}
  } as unknown as ToolContext
  return { ctx, asked, claims }
}

describe("using the user's own browser", () => {
  afterEach(() => setMacBridge(osascriptBridge))

  test('a site is allowed once per task, by the user', async () => {
    const chrome = fakeChrome({ k1: { label: 'Office cold opens · 30 minutes' } })
    setMacBridge(chrome.bridge)
    const { ctx, asked } = context(['allow'])
    await yourBrowserLook.execute({}, ctx)
    await yourBrowserLook.execute({}, ctx)
    assert.equal(asked.length, 1)
    assert.match(asked[0]!.prompt, /Let Kibu use youtube\.com in your Google Chrome/)
    assert.match(asked[0]!.prompt, /never your mouse or keyboard/)
  })

  test('a site the user turns down is not touched', async () => {
    const chrome = fakeChrome({ k1: { label: 'A video' } })
    setMacBridge(chrome.bridge)
    const { ctx } = context(['deny'])
    await assert.rejects(() => yourBrowserClick.execute({ ref: 'k1' }, ctx), /did not allow youtube\.com/)
    assert.ok(!chrome.ran.some((r) => r.kind === 'touch' && r.arg.dry === false))
  })

  test('an ordinary link is clicked without fuss, and the session shows it is Kibu', async () => {
    const chrome = fakeChrome({ k3: { label: 'Office cold opens to watch while you eat' } })
    setMacBridge(chrome.bridge)
    const { ctx, asked, claims } = context(['allow'])
    await yourBrowserClick.execute({ ref: 'k3' }, ctx)
    assert.equal(asked.length, 1, 'only the site question')
    assert.ok(chrome.ran.some((r) => r.kind === 'touch' && r.arg.dry === false && r.arg.ref === 'k3'))
    assert.deepEqual(claims, ['Kibu is using your browser'])
  })

  test('subscribing, sending or buying asks first, and a no means no click', async () => {
    const chrome = fakeChrome({ k9: { label: 'Subscribe' } })
    setMacBridge(chrome.bridge)
    const { ctx, asked } = context(['allow', 'no'])
    await assert.rejects(() => yourBrowserClick.execute({ ref: 'k9' }, ctx), /said no to “Subscribe”/)
    assert.match(asked[1]!.prompt, /Click “Subscribe” on www\.youtube\.com\?/)
    assert.ok(!chrome.ran.some((r) => r.kind === 'touch' && r.arg.dry === false))
    for (const label of ['Send', 'Post reply', 'Buy now', 'Place order', 'Delete video', 'Sign out']) assert.ok(isConsequential(label), label)
    for (const label of ['Home', 'Office cold opens', 'Search', 'Shorts']) assert.ok(!isConsequential(label), label)
  })

  test('never a password field or a sign-in form', async () => {
    const chrome = fakeChrome({ k1: { label: 'Password', type: 'password' }, k2: { label: 'Email', signIn: true } })
    setMacBridge(chrome.bridge)
    const { ctx } = context(['allow'])
    await assert.rejects(() => yourBrowserClick.execute({ ref: 'k1' }, ctx), /does not touch password fields/)
    await assert.rejects(() => yourBrowserType.execute({ ref: 'k2', text: 'me@example.com', submit: false }, ctx), /sign-in form/)
  })

  test('only references from a look are accepted, never code', () => {
    assert.throws(() => yourBrowserClick.input.parse({ ref: '"]; alert(1); //' }))
    assert.doesNotThrow(() => yourBrowserClick.input.parse({ ref: 'k12' }))
  })

  test('opening goes to a new tab in their browser, and only for web addresses', async () => {
    const chrome = fakeChrome({})
    setMacBridge(chrome.bridge)
    const { ctx } = context()
    const out = await yourBrowserOpen.execute({ url: 'https://www.youtube.com/' }, ctx)
    assert.equal(chrome.ran[0]!.kind, 'newTab')
    assert.equal((out.result as { browser: string }).browser, 'Google Chrome')
    assert.deepEqual(yourBrowserOpen.scopes({ url: 'https://www.youtube.com/' }), [{ kind: 'origin', url: 'https://www.youtube.com/' }])
    await assert.rejects(() => yourBrowserOpen.execute({ url: 'javascript:alert(1)' }, ctx))
  })

  test('"Chrome" means Google Chrome', async () => {
    setMacBridge(fakeChrome({}).bridge)
    assert.equal(await resolveAppName('Chrome'), 'Google Chrome')
  })
})

describe('Jev-style decisions about the web, from the local rules', () => {
  test('something to watch is personal: your browser, from the home feed', () => {
    const s = localPlanSetup('can you open chrome and play a good youtube video to watch while eating', 'browser', false)
    assert.equal(s.ownBrowser, true)
    assert.equal(s.start, 'feed')
  })
  test('a named thing is a search; a download is an unattended job', () => {
    assert.equal(localPlanSetup('search youtube for the new lofi mix', 'browser', false).start, 'search')
    assert.equal(localPlanSetup('download the latest invoice from acme.com', 'browser', false).ownBrowser, false)
    assert.equal(localPlanSetup('tidy my downloads folder', 'files', false).start, 'none')
  })
})

describe('the planner, for personal browsing', () => {
  afterEach(() => setMacBridge(osascriptBridge))

  test("is given only the user's own browser, and told to start from the feed", async () => {
    setMacBridge(fakeChrome({}).bridge)
    const menus: string[][] = []
    const notes: string[] = []
    const planner: PlannerLike = {
      seed() {}, addToolResults() {}, addNote(n) { notes.push(n) },
      async propose(tools): Promise<PlannerProposal> {
        menus.push(tools.map((t) => t.name))
        return { calls: [{ id: 'c', name: 'finish', input: { success: true, headline: 'ok' } }], text: '', stopReason: 'tool_use', usd: 0, inputTokens: 1, outputTokens: 1 }
      }
    }
    const registry = new ToolRegistry()
    registry.registerAll([...fileTools, ...userTools, ...browserTools, ...macTools, ...yourBrowserTools])
    const task: TaskState = {
      id: 't', request: 'play a good youtube video to watch while eating', outcome: '', status: 'pending', petState: 'idle',
      authorization: { ...emptyAuthorization(), capabilities: ['user.interact'] }, limits: defaultLimits(), observations: [], plan: [], actions: [],
      cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 }, completionCriteria: [], statusLine: '', createdAt: Date.now(), updatedAt: Date.now()
    }
    const deps: RunnerDeps = {
      os: { supports: () => false, listApps: async () => [], listDisplays: async () => [] } as unknown as RunnerDeps['os'],
      browser: { isOpen: () => false, close: async () => {}, page: async () => { throw new Error('the separate browser must not open') } } as unknown as RunnerDeps['browser'],
      registry, model: DEFAULT_MODEL_CONFIG, apiKey: null, jevEnabled: false, jevApiKey: null, workflowsEnabled: true,
      droppedPaths: [], frontWindow: null, previousTurn: null, confirmEveryAction: false, createPlanner: () => planner
    }
    await new TaskRunner(task, deps, { onUpdate() {}, onPetState() {}, onLog() {}, async claimDesktop() {}, releaseDesktop() {} }).run()
    const menu = menus[0]!
    assert.ok(menu.includes('your_browser_open') && menu.includes('your_browser_click'))
    assert.ok(!menu.includes('browser_navigate'), "Kibu's separate browser is not offered")
    assert.ok(notes.some((n) => /own browser/.test(n) && /home feed/.test(n)))
  })
})
