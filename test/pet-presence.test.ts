import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { PetPresence, type PetMode } from '../src/main/windows/pet-presence.js'

/** A window that only remembers whether it is showing. */
function harness(mode: PetMode = 'peek') {
  const state = { visible: false, held: false, mode, said: [] as boolean[] }
  const win = {
    isDestroyed: () => false,
    isVisible: () => state.visible,
    showInactive: () => { state.visible = true },
    hide: () => { state.visible = false },
    getBounds: () => ({ x: 1140, y: 700, width: 260, height: 190 })
  }
  const presence = new PetPresence({
    win: () => win,
    mode: () => state.mode,
    presence: (v) => state.said.push(v),
    displayAt: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    held: () => state.held
  })
  return { state, presence }
}

describe('where the pet is', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }))
  afterEach(() => mock.timers.reset())

  test('peeking, it stays out of sight while nothing is happening', () => {
    const { state, presence } = harness()
    presence.setState('idle')
    presence.update()
    assert.equal(state.visible, false)
  })

  test('it comes out while Kibu works, and tucks away a few seconds after it finishes', () => {
    const { state, presence } = harness()
    presence.setState('working')
    assert.equal(state.visible, true)
    presence.setState('finished')
    mock.timers.tick(5000)
    assert.equal(state.visible, true, 'it stays to show how it went')
    mock.timers.tick(1100)
    assert.deepEqual(state.said, [true, false], 'it says it is leaving, so it can slide out')
    mock.timers.tick(300)
    assert.equal(state.visible, false)
  })

  test('a question, a running timer or a due reminder keeps it out', () => {
    const { state, presence } = harness()
    presence.setState('waiting')
    assert.equal(state.visible, true)
    presence.setState('idle')
    presence.setAttention(true)
    mock.timers.tick(60_000)
    assert.equal(state.visible, true)
    presence.setAttention(false)
    mock.timers.tick(7000)
    assert.equal(state.visible, false)
  })

  test('resting the pointer on the right edge near the bottom calls it; moving away sends it back', () => {
    const { state, presence } = harness()
    presence.sample({ x: 1439, y: 800 })
    assert.equal(state.visible, false, 'a pointer passing by does not call it')
    mock.timers.tick(300)
    presence.sample({ x: 1439, y: 800 })
    assert.equal(state.visible, true)
    presence.sample({ x: 1200, y: 780 })
    mock.timers.tick(1000)
    presence.sample({ x: 1200, y: 780 })
    assert.equal(state.visible, true, 'it stays while the pointer is on it')
    presence.sample({ x: 300, y: 300 })
    mock.timers.tick(1300)
    presence.sample({ x: 300, y: 300 })
    mock.timers.tick(300)
    assert.equal(state.visible, false)
  })

  test('the top of the right edge and the very corner do not call it', () => {
    const { state, presence } = harness()
    for (const y of [100, 899]) {
      presence.sample({ x: 1439, y })
      mock.timers.tick(400)
      presence.sample({ x: 1439, y })
    }
    assert.equal(state.visible, false)
  })

  test('menu bar only never shows it; always on the desktop never hides it', () => {
    const menubar = harness('menubar')
    menubar.presence.setState('working')
    assert.equal(menubar.state.visible, false)
    const desktop = harness('desktop')
    desktop.presence.update()
    desktop.presence.setState('idle')
    mock.timers.tick(60_000)
    desktop.presence.update()
    assert.equal(desktop.state.visible, true)
  })

  test('switching to peek while idle tucks it away', () => {
    const { state, presence } = harness('desktop')
    presence.update()
    assert.equal(state.visible, true)
    state.mode = 'peek'
    presence.update()
    mock.timers.tick(300)
    assert.equal(state.visible, false)
  })
})
