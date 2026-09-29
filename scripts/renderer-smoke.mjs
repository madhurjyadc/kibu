/** UI regression checks use a fake IPC bridge; they never touch user files or model services. */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const server = await createServer({ configFile: false, root: 'src/renderer', plugins: [react()], server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 620, height: 440 }, reducedMotion: 'reduce' })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const artifacts = process.env.KIBU_SCREENSHOT_DIR || '/tmp/kibu-design'
await mkdir(artifacts, { recursive: true })
await page.addInitScript(() => {
  const listeners = {}
  const state = { calls: [], history: [], failStart: false, ready: true, panel: { docked: false, pinned: false }, settings: { onboarded: false, launchAtLogin: false, chatty: true, workflowsFirst: true, jevEnabled: true, confirmEveryAction: false, maxUsdPerTask: 1.5, shortcut: 'Alt+Space', useClaudeCode: false, memoryEnabled: true, memoryLearn: true }, memories: [
    { id: 'm1', text: 'My manager is Priya', kind: 'fact', keys: ['manager', 'priya'], source: 'told', evidence: 1, createdAt: 1, updatedAt: 2, lastUsedAt: null, uses: 2 },
    { id: 'm2', text: 'Events like "Standup" go on the Work calendar', kind: 'choice', keys: ['standup'], choice: { decision: 'calendar', value: 'Work' }, source: 'learned', evidence: 2, createdAt: 1, updatedAt: 1, lastUsedAt: null, uses: 0 }
  ] }
  window.__test = { state, emit: (event, payload) => (listeners[event] || []).forEach((f) => f(payload)) }
  const sub = (event) => (cb) => { (listeners[event] ||= []).push(cb); return () => { listeners[event] = listeners[event].filter((f) => f !== cb) } }
  state.brain = { items: [], timer: null }
  state.setup = [
    { id: 'accessibility', group: 'control', label: 'Accessibility', purpose: 'Read what is in app windows and press their buttons.', status: 'not-asked' },
    { id: 'app:com.apple.iCal', group: 'apps', label: 'Calendar', purpose: 'Read your agenda and add events you ask for.', status: 'not-asked' },
    { id: 'app:com.google.Chrome', group: 'browsers', label: 'Google Chrome', purpose: 'See your open tabs and read the page you are on.', status: 'granted', hint: 'Also turn on View → Developer → Allow JavaScript from Apple Events.' },
    { id: 'folder:Downloads', group: 'folders', label: 'Downloads', purpose: 'Find, tidy and rename files in Downloads.', status: 'not-asked' },
    { id: 'notifications', group: 'alerts', label: 'Notifications', purpose: 'Reminders and timers.', status: 'not-asked' }
  ]
  window.kibu = {
    getBrain: async () => state.brain,
    onBrainChanged: sub('brain'), onBrainOpen: sub('brain-open'), openBrain: async () => window.__test.emit('brain-open'),
    onPetPlay: sub('play'), onPetPresence: sub('presence'), onCursor: sub('cursor'), showPetMenu: async () => {},
    brainRequest: async (req) => {
      state.calls.push(['brain', req])
      if (req.op === 'create') state.brain.items.unshift({ id: `brain-${state.brain.items.length}`, status: 'open', body: '', projectId: null, dueAt: null, repeat: 'none', estimateMinutes: null, sources: [], checks: [], createdAt: Date.now(), updatedAt: Date.now(), notifiedAt: null, acknowledgedAt: null, ...req.item })
      if (req.op === 'update') Object.assign(state.brain.items.find(i => i.id === req.id), req.changes)
      if (req.op === 'complete') state.brain.items.find(i => i.id === req.id).status = 'done'
      if (req.op === 'archive') state.brain.items.find(i => i.id === req.id).status = 'archived'
      if (req.op === 'reopen') state.brain.items.find(i => i.id === req.id).status = 'open'
      if (req.op === 'snooze') state.brain.items.find(i => i.id === req.id).dueAt = Date.now() + req.minutes * 60000
      if (req.op === 'timer') {
        if (req.action === 'start') state.brain.timer = { id: 'timer', label: req.label ?? 'Focus time', status: 'running', endsAt: Date.now() + req.minutes * 60000, durationMs: req.minutes * 60000, remainingMs: req.minutes * 60000, notifiedAt: null }
        else if (req.action === 'cancel') state.brain.timer = null
        else state.brain.timer.status = req.action === 'pause' ? 'paused' : 'running'
      }
      window.__test.emit('brain', structuredClone(state.brain))
      return state.brain
    },
    canWork: async () => state.ready, getPermissions: async () => [{ permission: 'accessibility', granted: false, purpose: 'Control native Mac apps when you ask.' }], listHistory: async () => state.history,
    getFrontWindow: async () => ({ pid: 123, name: 'Finder', title: 'Downloads' }),
    getPanelState: async () => state.panel,
    minimizePanel: async () => { state.panel = { ...state.panel, docked: !state.panel.docked }; state.calls.push(['minimize', state.panel.docked]); window.__test.emit('panel', state.panel) },
    pinPanel: async (pinned) => { state.panel = { ...state.panel, pinned }; state.calls.push(['pin', pinned]); window.__test.emit('panel', state.panel) },
    startTask: async (req) => { if (state.failStart) throw new Error('Test connection unavailable'); state.calls.push(['start', req]) },
    choosePaths: async () => ['/test/selected.pdf'],
    deleteTask: async (id) => { state.calls.push(['delete', id]); state.history = state.history.filter((r) => r.id !== id); window.__test.emit('deleted', [id]) },
    clearHistory: async () => { const ids = state.history.filter((r) => ['succeeded', 'failed', 'cancelled'].includes(r.status)).map((r) => r.id); state.history = state.history.filter((r) => !ids.includes(r.id)); state.calls.push(['clear']); window.__test.emit('deleted', ids) },
    answerQuestion: async (req) => state.calls.push(['answer', req]), closePanel: async () => {},
    onHistoryDeleted: sub('deleted'), onTaskUpdate: sub('task'), onLog: sub('log'), onDroppedPaths: sub('drop'), onPetState: sub('pet'), onDesktopSession: sub('desktop'), onFocusInput: sub('focus'), onPanelState: sub('panel'), onSeed: sub('seed'), petCompose: async () => {},
    getSettings: async () => state.settings, setSettings: async (next) => ({ ...Object.assign(state.settings, next) }), hasApiKey: async () => false, hasJevKey: async () => false, hasClaudeCode: async () => true, codingApps: async () => [{ id: 'claude-code', label: 'Claude Code', available: true }, { id: 'codex', label: 'Codex', available: true }, { id: 'opencode', label: 'OpenCode', available: false }],
    setApiKey: async () => { state.calls.push(['key']); state.ready = true; return true }, setJevKey: async () => { state.calls.push(['jev-key']); return true },
    requestPermission: async () => {},
    getSetup: async () => structuredClone(state.setup),
    requestSetup: async (id) => { state.calls.push(['setup', id]); const item = state.setup.find((i) => i.id === id); item.status = id === 'notifications' ? 'asked' : 'granted'; return structuredClone(item) },
    openSetupSettings: async (id) => state.calls.push(['setup-settings', id]), resizePanel: async () => {}, pauseTask: async (id) => state.calls.push(['pause', id]), resumeTask: async () => {}, cancelTask: async (id) => state.calls.push(['cancel', id]),
    getTask: async () => state.task, undoTask: async () => ({ reversed: 2, skipped: [] }), stopDesktopSession: async () => {},
    openUrl: async (url) => state.calls.push(['url', url]), dragPanel: async (phase) => state.calls.push(['drag', phase]), centerPanel: async () => state.calls.push(['center']), openPath: async () => {}, revealPath: async () => {}, getPathForFile: () => '/test/file.txt', runBench: async () => [],
    setPetInteractive: async () => {}, setPetHitRects: async () => {},
    listMemories: async () => state.memories, deleteMemory: async (id) => { state.memories = state.memories.filter((m) => m.id !== id); state.calls.push(['forget', id]); return state.memories },
    clearMemories: async () => { state.memories = []; state.calls.push(['forget-all']); return [] }, onMemoriesChanged: sub('memories')
  }
})
const task = {
  id: 'test-task', request: 'Organize my Downloads folder', status: 'awaiting_user', petState: 'waiting', statusLine: 'Review these changes',
  authorization: { readRoots: [], writeRoots: [], apps: [], origins: [], capabilities: [] }, limits: { maxSteps: 40, maxUsd: 1.5, maxWallClockMs: 600000, maxConsecutiveFailures: 3 },
  observations: [], plan: [], actions: [], cost: { usd: 0.003, inputTokens: 10, outputTokens: 10, calls: 1 }, completionCriteria: [], createdAt: Date.now(), updatedAt: Date.now(),
  question: { id: 'q1', reason: 'ambiguous', prompt: 'What naming style would you like?', options: [{ id: 'yes', label: 'Use these names' }, { id: 'no', label: 'Keep the originals' }], allowFreeText: true, preview: { title: 'Review 12 file changes', fileOps: Array.from({ length: 12 }, (_, i) => ({ from: `/test/IMG_${i}.png`, to: `/test/holiday-${i}.png`, kind: 'rename' })) } }
}
try {
  await page.goto(`${server.resolvedUrls.local[0]}#panel`)
  // First run opens on setup, and setup can be skipped outright.
  await page.getByText('Hi, I’m Kibu.').waitFor()
  await page.screenshot({ path: `${artifacts}/welcome.png` })
  await page.getByRole('button', { name: 'Skip tour', exact: true }).click()
  await page.getByRole('button', { name: 'Find', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.__test.state.settings.onboarded), true, 'Skipping setup must not show it again')
  assert.ok((await page.locator('body').innerText()).split(/\s+/).length < 35, 'Idle UI should stay concise')
  assert.equal(await page.evaluate(() => { const main = document.querySelector('.workspace'); return main.scrollHeight > main.clientHeight }), false, 'The ready home should fit without scrolling')
  await page.screenshot({ path: `${artifacts}/home.png` })
  await page.getByRole('button', { name: 'Organize', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#composer').value.includes('Organize my Downloads'))
  assert.match(await page.locator('#composer').inputValue(), /Organize my Downloads/)
  assert.equal(await page.evaluate(() => window.__test.state.calls.filter((c) => c[0] === 'start').length), 0, 'Suggestions must not execute tasks')
  await page.evaluate(() => { window.__test.state.failStart = true; window.__test.emit('drop', ['/test/holiday.png']) })
  await page.getByRole('button', { name: 'Send task', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Test connection unavailable' }).waitFor()
  assert.match(await page.locator('#composer').inputValue(), /Organize/)
  assert.equal(await page.locator('.chip').first().textContent(), 'holiday.png', 'Failure must preserve file context')
  await page.evaluate(() => { window.__test.state.failStart = false })
  await page.getByRole('button', { name: 'Send task', exact: true }).click()
  await page.waitForFunction(() => window.__test.state.calls.some((c) => c[0] === 'start'))
  const start = await page.evaluate(() => window.__test.state.calls.find((c) => c[0] === 'start')[1])
  assert.deepEqual(start.droppedPaths, ['/test/holiday.png'])
  await page.setViewportSize({ width: 620, height: 620 })
  await page.evaluate((t) => window.__test.emit('task', t), task)
  await page.locator('#composer').fill('Use lowercase with dashes please')
  await page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await page.waitForFunction(() => window.__test.state.calls.some((c) => c[0] === 'answer'))
  const answer = await page.evaluate(() => window.__test.state.calls.find((c) => c[0] === 'answer')[1])
  assert.equal(answer.text, 'Use lowercase with dashes please')
  assert.equal(answer.questionId, 'q1')
  await page.getByRole('button', { name: 'Show all 12 changes' }).click()
  assert.equal(await page.locator('.op-to').count(), 12)
  assert.match(await page.locator('.op-to').first().textContent(), /holiday-0.png/)
  await page.screenshot({ path: `${artifacts}/preview.png` })
  await page.getByRole('button', { name: '1 Use these names', exact: true }).click()
  await page.evaluate((t) => window.__test.emit('task', { ...t, question: { ...t.question, id: 'q2', prompt: 'Ready for the next set?' } }), task)
  await page.getByText('Ready for the next set?').waitFor()
  assert.equal(await page.getByRole('button', { name: '1 Use these names', exact: true }).isEnabled(), true, 'A new question must reset answer controls')
  await page.getByRole('button', { name: '2 Keep the originals', exact: true }).click()
  await page.waitForFunction(() => window.__test.state.calls.some((c) => c[0] === 'answer' && c[1].questionId === 'q2'))

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Anthropic', { exact: true }).waitFor()
  await page.evaluate((t) => window.__test.emit('task', { ...t, status: 'executing', question: undefined }), task)
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
  await page.getByLabel('Anthropic', { exact: true }).fill('test-key-not-real')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.getByText('Saved to Keychain.').waitFor()
  await page.screenshot({ path: `${artifacts}/settings.png` })
  // Memory: what is kept is visible in the person's own words, and each item can be forgotten.
  await page.getByText('My manager is Priya').waitFor()
  await page.getByText('I picked up').waitFor()
  await page.getByText('My manager is Priya').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${artifacts}/memory.png` })
  await page.getByRole('button', { name: 'Forget: My manager is Priya' }).click()
  await page.waitForFunction(() => window.__test.state.calls.some((c) => c[0] === 'forget' && c[1] === 'm1'))
  await page.getByText('My manager is Priya').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Forget everything', exact: true }).click()
  await page.getByText('Forget all 1?').waitFor()
  await page.getByRole('button', { name: 'Forget everything', exact: true }).click()
  await page.waitForFunction(() => window.__test.state.calls.some((c) => c[0] === 'forget-all'))
  await page.getByRole('button', { name: /Task in progress/ }).click()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__test.state.calls.filter((c) => c[0] === 'pause').length), 1)
  const done = { ...task, status: 'succeeded', petState: 'finished', question: undefined, summary: { headline: 'Your Downloads folder is a little lighter.', evidence: [{ kind: 'path', label: 'Open organized files', value: '/test/Downloads' }, { kind: 'url', label: 'Open source page', value: 'https://example.com/' }], undoable: true } }
  await page.evaluate((t) => window.__test.emit('task', t), done)
  await page.getByRole('button', { name: 'Open source page' }).click()
  assert.equal(await page.evaluate(() => window.__test.state.calls.filter((c) => c[0] === 'url').length), 1)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByText('2 restored').waitFor()
  await page.screenshot({ path: `${artifacts}/result.png` })
  // Continuing and starting over are different places: the reply box under a
  // chat continues it; the launcher, reached by New chat or ⌘N, starts clean.
  const starts = () => page.evaluate(() => window.__test.state.calls.filter((c) => c[0] === 'start').map((c) => c[1]))
  const before = (await starts()).length
  await page.getByLabel('Reply to Kibu', { exact: true }).fill('Now do the same for Desktop')
  await page.getByRole('button', { name: 'Send reply', exact: true }).click()
  await page.waitForFunction((n) => window.__test.state.calls.filter((c) => c[0] === 'start').length > n, before)
  assert.equal((await starts()).at(-1).followUp, 'test-task', 'A reply continues the chat it is under')
  await page.evaluate((t) => window.__test.emit('task', { ...t, id: 'test-task-2', replyTo: 'test-task', request: 'Now do the same for Desktop', actions: [], summary: { headline: 'Desktop is tidy too.', evidence: [{ kind: 'text', label: 'Kibu workspace', value: 'Saved to your workspace on this Mac.' }], undoable: false } }), done)
  await page.getByRole('main').getByText('Desktop is tidy too.').waitFor()
  await page.getByRole('main').getByText('Your Downloads folder is a little lighter.').waitFor()
  assert.match(await page.locator('.chat-title strong').textContent(), /Organize my Downloads/, 'The chat is named after how it began')
  assert.equal(await page.locator('.turn-past').count(), 1)
  await page.screenshot({ path: `${artifacts}/chat.png` })
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await page.getByRole('heading', { name: 'Workspace' }).waitFor()
  await page.getByRole('button', { name: 'Back home' }).click()
  await page.getByRole('button', { name: 'Delete conversation' }).click()
  await page.getByText('Delete this conversation and its undo history? Files stay.').waitFor()
  assert.equal(await page.evaluate(() => window.__test.state.calls.some((c) => c[0] === 'delete')), false, 'Deletion requires an explicit click')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Find', exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.__test.state.calls.filter((c) => c[0] === 'delete').map((c) => c[1])), ['test-task', 'test-task-2'], 'Deleting a chat deletes every turn of it')
  await page.evaluate((t) => window.__test.emit('task', { ...t, id: 'test-task-3' }), done)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByRole('button', { name: 'Find', exact: true }).waitFor()
  await page.getByLabel('Ask Kibu for help', { exact: true }).fill('What is on my calendar?')
  await page.getByRole('button', { name: 'Send task', exact: true }).click()
  await page.waitForFunction((n) => window.__test.state.calls.filter((c) => c[0] === 'start').length > n + 1, before)
  assert.equal((await starts()).at(-1).followUp, null, 'The launcher starts a new chat')
  await page.evaluate((t) => window.__test.emit('task', { ...t, id: 'test-task-4' }), done)
  await page.getByLabel('Reply to Kibu', { exact: true }).press('Meta+n')
  await page.getByRole('button', { name: 'Find', exact: true }).waitFor()
  await page.evaluate(() => {
    window.__test.state.history = [
      { id: 'old1', request: 'Find my document', status: 'succeeded', headline: 'Found', createdAt: Date.now(), undoable: false },
      { id: 'old2', request: 'Rename screenshots', status: 'succeeded', headline: 'Renamed', createdAt: Date.now(), undoable: true }
    ]
  })
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: 'Delete Find my document', exact: true }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.waitForFunction(() => window.__test.state.history.length === 1)
  await page.screenshot({ path: `${artifacts}/history.png` })
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await page.getByRole('button', { name: 'Delete all', exact: true }).click()
  await page.getByText('No saved chats.').waitFor()
  await page.getByRole('button', { name: 'Kibu home' }).click()
  await page.getByRole('button', { name: 'Attach files', exact: true }).click()
  await page.getByText('selected.pdf', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Remove attached files' }).click()
  // Staying put: pinning, collapsing to the edge handle, and opening back out
  // without losing what was half-typed.
  await page.locator('#composer').fill('Half-written thought')
  await page.getByRole('button', { name: 'Keep in front' }).click()
  await page.waitForFunction(() => window.__test.state.panel.pinned === true)
  await page.getByRole('button', { name: 'Minimize to island' }).click()
  await page.locator('.kibu.is-docked').waitFor()
  await page.setViewportSize({ width: 300, height: 46 })
  await page.screenshot({ path: `${artifacts}/docked.png` })
  await page.getByRole('button', { name: 'Open Kibu', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.kibu').classList.contains('is-docked'))
  await page.setViewportSize({ width: 620, height: 440 })
  assert.equal(await page.locator('#composer').inputValue(), 'Half-written thought', 'Collapsing to the edge must not lose a draft')
  await page.locator('#composer').fill('')

  // Moving like Spotlight: pressing empty space drags the window; pressing a
  // control or the text box never does.
  await page.evaluate(() => { window.__test.state.calls = [] })
  const box = await page.locator('.statusbar').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 40, box.y + 10); await page.mouse.up()
  const phases = await page.evaluate(() => window.__test.state.calls.filter((c) => c[0] === 'drag').map((c) => c[1]))
  assert.equal(phases[0], 'start'); assert.ok(phases.includes('move')); assert.equal(phases.at(-1), 'end')
  await page.evaluate(() => { window.__test.state.calls = [] })
  await page.locator('#composer').click()
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: 'Back home' }).click()
  assert.equal(await page.evaluate(() => window.__test.state.calls.some((c) => c[0] === 'drag')), false, 'Controls and the text box must not move the window')
  await page.locator('.bar-face').dblclick()
  assert.equal(await page.evaluate(() => window.__test.state.calls.some((c) => c[0] === 'center')), true, 'Double-clicking empty space re-centres')

  await page.setViewportSize({ width: 420, height: 360 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.getByRole('button', { name: 'Send task', exact: true }).isVisible(), true)
  await page.screenshot({ path: `${artifacts}/compact.png` })
  await page.setViewportSize({ width: 620, height: 700 })
  await page.getByRole('button', { name: 'Workspace', exact: true }).click()
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByLabel('Item title', { exact: true }).fill('Acme launch notes')
  await page.getByLabel('Item details', { exact: true }).fill('Use the monochrome logo. Next: revise the mobile header.')
  await page.getByLabel('Source link', { exact: true }).fill('https://example.com/brief')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: 'Acme launch notes', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Item title', { exact: true }).fill('Acme revised notes')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Acme revised notes', exact: true }).waitFor()
  await page.getByLabel('Search workspace').fill('mobile header')
  assert.equal(await page.locator('.brain-card').count(), 1)
  await page.getByLabel('Search workspace').fill('')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.screenshot({ path: `${artifacts}/workspace.png` })
  await page.locator('.brain-actions').getByRole('button', { name: 'Archive', exact: true }).click()
  await page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('button', { name: 'Archive', exact: true }).click()
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: 'Acme revised notes', exact: true }).waitFor()
  await page.setViewportSize({ width: 420, height: 600 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: `${artifacts}/workspace-compact.png` })
  // Setup again from Settings: every permission is its own tap, and nothing is asked for without one.
  await page.setViewportSize({ width: 620, height: 640 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByText('Permissions · 1 of 5 allowed').waitFor()
  await page.getByRole('button', { name: 'Run setup again' }).click()
  // The first card names the shortcut, and it can be changed by pressing a new one.
  await page.getByRole('button', { name: /Shortcut ⌥ Option Space/ }).click()
  await page.keyboard.press('Meta+Shift+J')
  await page.waitForFunction(() => window.__test.state.settings.shortcut === 'Command+Shift+J')
  await page.getByRole('button', { name: 'Show me', exact: true }).click()
  await page.getByText('How should I think?').waitFor()
  // Every coding app on the Mac is offered by name, next to an API key; the Jev key is asked for too.
  await page.getByRole('radio', { name: /Codex/ }).click()
  await page.waitForFunction(() => window.__test.state.settings.useClaudeCode === true && window.__test.state.settings.codingApp === 'codex')
  await page.getByRole('radio', { name: /Claude Code/ }).click()
  await page.waitForFunction(() => window.__test.state.settings.codingApp === 'claude-code')
  assert.equal(await page.getByRole('radio', { name: /OpenCode/ }).count(), 0, 'Apps that are not installed are not offered')
  await page.getByLabel('TypeSafe', { exact: true }).fill('test-jev-key')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => window.__test.state.calls.some((c) => c[0] === 'jev-key'))
  await page.screenshot({ path: `${artifacts}/welcome-think.png` })
  await page.keyboard.press('Enter')
  await page.getByText('Files.', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.__test.state.calls.some((c) => c[0] === 'setup')), false, 'Showing a card must not ask for anything')
  await page.getByRole('button', { name: 'Allow Downloads', exact: true }).click()
  await page.waitForFunction(() => window.__test.state.setup.find((i) => i.id === 'folder:Downloads').status === 'granted')
  await page.screenshot({ path: `${artifacts}/welcome-files.png` })
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByText('Your day.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Allow Calendar', exact: true }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByText('The web.', { exact: true }).waitFor()
  await page.getByText('Also turn on View → Developer → Allow JavaScript from Apple Events.').waitFor()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByText('Other apps.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Allow Accessibility', exact: true }).click()
  await page.screenshot({ path: `${artifacts}/welcome-apps.png` })
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByText('Remember & remind.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Allow Notifications', exact: true }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByText('That’s it.', { exact: true }).waitFor()
  await page.getByText('Claude Code', { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.__test.state.calls.filter((c) => c[0] === 'setup').map((c) => c[1])), ['folder:Downloads', 'app:com.apple.iCal', 'accessibility', 'notifications'], 'Each permission is asked for only by its own tap')
  await page.screenshot({ path: `${artifacts}/welcome-ready.png` })
  const startsBefore = await page.evaluate(() => window.__test.state.calls.filter((c) => c[0] === 'start').length)
  await page.getByRole('button', { name: 'Organize my Downloads folder' }).click()
  await page.waitForFunction(() => document.querySelector('#composer')?.value === 'Organize my Downloads folder')
  assert.equal(await page.evaluate(() => window.__test.state.calls.filter((c) => c[0] === 'start').length), startsBefore, 'A suggestion fills the composer without running')
  await page.evaluate(() => { window.__test.state.settings.useClaudeCode = false; window.__test.state.settings.shortcut = 'Alt+Space' })

  await page.setViewportSize({ width: 260, height: 190 })
  await page.goto(`${server.resolvedUrls.local[0]}?pet-test=1#pet`)
  await page.locator('.pet-root').waitFor()
  await page.evaluate(() => {
    window.__test.state.brain.timer = { id: 'timer', label: 'Focus time', status: 'running', durationMs: 1500000, remainingMs: 1500000, endsAt: Date.now() + 1500000, notifiedAt: null }
    window.__test.emit('brain', structuredClone(window.__test.state.brain))
  })
  await page.locator('.kb-sprite.is-timer').waitFor()
  await page.screenshot({ path: `${artifacts}/pet-timer.png` })
  await page.evaluate(() => {
    window.__test.state.brain.timer.status = 'ringing'
    window.__test.state.brain.timer.endsAt = Date.now() - 1000
    window.__test.emit('brain', structuredClone(window.__test.state.brain))
  })
  await page.getByText('Time’s up — Focus time.').waitFor()
  await page.screenshot({ path: `${artifacts}/pet-timer-due.png` })
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.kb-sprite.is-timer'))
  await page.evaluate(() => {
    window.__test.state.brain.items = [{ id: 'reminder', kind: 'reminder', title: 'Send the client proposal', body: '', status: 'open', dueAt: Date.now() - 1000, acknowledgedAt: null, sources: [], checks: [] }]
    window.__test.emit('brain', structuredClone(window.__test.state.brain))
  })
  await page.getByText('Send the client proposal').waitFor()
  await page.getByRole('button', { name: '10 min', exact: true }).click()
  await page.waitForFunction(() => window.__test.state.brain.items[0].dueAt > Date.now())
  assert.deepEqual(errors, [], 'No renderer exceptions')
  console.log('Renderer checks passed: first-run tour (skip, shortcut recorder, thinking choice, each permission asked only by its own tap, try-it), minimal home, memory list and forgetting, editable suggestions, failure recovery, attachments, answers, previews, settings, keys, pause, undo, task deletion, clear history, pin, minimize to the island and back, drag to move, compact layout, workspace editing/search/archive, timer controls and pet transformation, and reminder snoozing.')
  console.log(`Screenshots: ${artifacts}`)
} finally { await browser.close(); await server.close() }
