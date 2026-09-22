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
  const state = { calls: [], history: [], failStart: false, ready: true, panel: { docked: false, pinned: false }, settings: { workflowsFirst: true, jevEnabled: true, confirmEveryAction: false, maxUsdPerTask: 1.5, shortcut: 'CommandOrControl+Shift+K', useClaudeCode: false } }
  window.__test = { state, emit: (event, payload) => (listeners[event] || []).forEach((f) => f(payload)) }
  const sub = (event) => (cb) => { (listeners[event] ||= []).push(cb); return () => { listeners[event] = listeners[event].filter((f) => f !== cb) } }
  window.kibu = {
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
    getSettings: async () => state.settings, setSettings: async (next) => Object.assign(state.settings, next), hasApiKey: async () => false, hasJevKey: async () => false, hasClaudeCode: async () => true,
    setApiKey: async () => { state.calls.push(['key']); state.ready = true; return true }, setJevKey: async () => true,
    requestPermission: async () => {}, resizePanel: async () => {}, pauseTask: async (id) => state.calls.push(['pause', id]), resumeTask: async () => {}, cancelTask: async (id) => state.calls.push(['cancel', id]),
    getTask: async () => state.task, undoTask: async () => ({ reversed: 2, skipped: [] }), stopDesktopSession: async () => {},
    openUrl: async (url) => state.calls.push(['url', url]), dragPanel: async (phase) => state.calls.push(['drag', phase]), centerPanel: async () => state.calls.push(['center']), openPath: async () => {}, revealPath: async () => {}, getPathForFile: () => '/test/file.txt', runBench: async () => []
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
  await page.getByRole('button', { name: 'Find', exact: true }).waitFor()
  assert.ok((await page.locator('body').innerText()).split(/\s+/).length < 12, 'Idle UI should have very little text')
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
  await page.getByRole('button', { name: 'Delete this task' }).click()
  await page.getByText('Delete task and undo history? Files stay.').waitFor()
  assert.equal(await page.evaluate(() => window.__test.state.calls.some((c) => c[0] === 'delete')), false, 'Deletion requires an explicit click')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Find', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.__test.state.calls.some((c) => c[0] === 'delete')), true)
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
  await page.getByText('No saved tasks.').waitFor()
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
  assert.deepEqual(errors, [], 'No renderer exceptions')
  console.log('Renderer checks passed: minimal home, editable suggestions, failure recovery, attachments, answers, previews, settings, keys, pause, undo, task deletion, clear history, pin, minimize to the island and back, drag to move, compact layout.')
  console.log(`Screenshots: ${artifacts}`)
} finally { await browser.close(); await server.close() }
