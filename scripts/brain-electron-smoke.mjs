/** Main/preload/runtime integration in an isolated Electron profile. No model calls or user data. */
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const directory = await mkdtemp(join(tmpdir(), 'kibu-electron-'))
const bootstrap = join(directory, 'bootstrap.mjs')
await writeFile(bootstrap, `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(directory)});\napp.setAppPath(${JSON.stringify(process.cwd())});\napp.setName('Kibu workspace test');\nawait import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});\n`)
let application
async function launch() {
  application = await electron.launch({ args: [bootstrap], timeout: 30000 })
  await application.firstWindow()
  let panel
  for (let attempt = 0; attempt < 60; attempt++) {
    panel = application.windows().find(p => p.url().includes('#panel'))
    if (panel) break
    await new Promise(r => setTimeout(r, 100))
  }
  assert.ok(panel, 'Panel window created')
  await panel.waitForFunction(() => !!window.kibu?.getBrain)
  return panel
}
try {
  let panel = await launch()
  // The runtime announces readiness asynchronously; startup does not block the interface.
  await new Promise(r => setTimeout(r, 1000))
  const task = await panel.evaluate(() => window.kibu.startTask({ request: 'Note: Kibu integration test' }))
  await panel.waitForFunction(async id => (await window.kibu.getTask(id))?.status === 'succeeded', task.id)
  const result = await panel.evaluate(async id => ({ task: await window.kibu.getTask(id), brain: await window.kibu.getBrain() }), task.id)
  assert.ok(result.task.actions.some(a => a.tool === 'kibu_workspace' && a.verification?.verified))
  assert.equal(result.brain.items[0].body, 'Kibu integration test')
  await panel.evaluate(() => window.kibu.brainRequest({ op: 'timer', action: 'start', minutes: 2 / 60, label: 'Kibu integration timer' }))
  await panel.waitForFunction(async () => (await window.kibu.getBrain()).timer?.status === 'ringing')
  await application.close(); application = null
  panel = await launch()
  const restored = await panel.evaluate(() => window.kibu.getBrain())
  assert.equal(restored.items[0].body, 'Kibu integration test')
  assert.equal(restored.timer.status, 'ringing')
  await panel.evaluate(() => window.kibu.brainRequest({ op: 'timer', action: 'cancel' }))
  console.log('Electron checks passed: real preload IPC, runtime save + readback, timer delivery, and persistence across app restart in an isolated profile.')
} finally { if (application) await application.close(); await rm(directory, { recursive: true, force: true }) }
