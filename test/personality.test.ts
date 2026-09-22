import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkIn, idleRemark, onStart, successMood, hello, reactions } from '../src/renderer/src/lib/personality.js'
import { MOODS } from '../src/renderer/src/components/Sprite.js'
import { parseBlocks, plainText, stripEmoji } from '../src/renderer/src/components/Markdown.js'

test('check-ins only claim progress the plan actually shows', () => {
  assert.equal(checkIn({ seconds: 40, done: 3, total: 5, turn: 0 }).text, '3 of 5 steps done. Still going.')
  for (let turn = 0; turn < 8; turn++) {
    const line = checkIn({ seconds: 60, done: 0, total: 0, turn })
    assert.doesNotMatch(line.text, /almost|nearly|soon|\d+%/i, line.text)
  }
})

test('unprompted offers never run anything: they only fill the composer or open the panel', () => {
  for (let hour = 0; hour < 24; hour++) {
    for (let turn = 0; turn < 12; turn++) {
      const line = idleRemark(hour, turn * 20, turn)
      if (line.action) assert.ok(line.action.compose !== undefined || line.action.open, line.text)
      assert.ok(MOODS.includes(line.mood), line.mood)
    }
  }
})

test('every line uses a mood the face can draw', () => {
  const lines = [hello(8), hello(23), onStart('find my passport'), onStart('tidy downloads'), onStart('what is 2+2?'), ...Object.values(reactions).map((f) => f(2))]
  for (const l of lines) assert.ok(MOODS.includes(l.mood), `${l.text} → ${l.mood}`)
})

test('big jobs celebrate, quick ones play it cool', () => {
  assert.equal(successMood(10, 20), 'celebrate')
  assert.equal(successMood(2, 1.5), 'cool')
  assert.equal(successMood(0, 1), 'proud')
})

test('emoji become list items or disappear', () => {
  assert.equal(stripEmoji('📁 **Files** — find things'), '- **Files** — find things')
  assert.equal(stripEmoji('Done 🎉 nice'), 'Done nice')
  const blocks = parseBlocks('Hey:\n\n📁 **Files** — find\n🌐 **Web** — browse')
  assert.equal(blocks[1]?.kind, 'ul')
  assert.equal(plainText('**Sorted** 3 files 🎉'), 'Sorted 3 files')
})
