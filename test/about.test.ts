import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAboutKibu, isAboutModel, describeModels, describeSelf } from '../src/runtime/loop/about.js'
import { DEFAULT_MODEL_CONFIG } from '../src/shared/protocol.js'
import type { OsAdapter } from '../src/os/adapter.js'

function os(supported: string[]): OsAdapter {
  return { supports: (c: string) => supported.includes(c) } as unknown as OsAdapter
}

test('questions about Kibu are recognised, including sloppy ones', () => {
  for (const q of [
    'hi!!! what can u do?',
    'what can you do',
    'who are you?',
    'What do you do?',
    'hey, wat can u do',
    'help',
    'what can you do bro?',
    'what can you do lol?',
    'what can you do for me, kibu?'
  ]) {
    assert.equal(isAboutKibu(q), true, q)
  }
})

test('real work is not mistaken for a question about Kibu', () => {
  for (const q of [
    'tidy up my Downloads',
    'find the invoice I saved yesterday',
    'help me rename these screenshots so they are sorted by date',
    'what can you do about the mess in my Downloads folder, there are hundreds of files in there',
    'what can you do for me in Figma bro'
  ]) {
    assert.equal(isAboutKibu(q), false, q)
  }
})

test('the description tells the truth about permissions it does not have', () => {
  const blind = describeSelf(os([]), true, true)
  const mac = blind.evidence.find((e) => e.label === 'Your Mac')!
  assert.match(mac.value, /Accessibility/)
  assert.match(blind.headline, /as soon as you let me see them/)

  const seeing = describeSelf(os(['window.inspect', 'window.capture']), true, true)
  const mac2 = seeing.evidence.find((e) => e.label === 'Your Mac')!
  assert.doesNotMatch(mac2.value, /Accessibility/)
  assert.match(seeing.headline, /your apps, and the web/)
})

test('it says when it has no way to think at all', () => {
  const unset = describeSelf(os(['window.inspect']), false, true)
  assert.ok(unset.evidence.some((e) => e.label === 'Not set up yet'))
  const ready = describeSelf(os(['window.inspect']), true, true)
  assert.ok(!ready.evidence.some((e) => e.label === 'Not set up yet'))
})

test('"which model are you" is answered from configuration, not by a model', () => {
  for (const q of ['which model u using', 'what model are you?', 'what ai r u', 'are you chatgpt?', 'hey which llm do you run on']) {
    assert.equal(isAboutModel(q), true, q)
  }
  for (const q of ['what model should I use for embeddings', 'what model do you recommend for my laptop', 'find the 3d model files on my desktop']) {
    assert.equal(isAboutModel(q), false, q)
  }
  const cc = describeModels('claude-code', DEFAULT_MODEL_CONFIG, true)
  assert.match(cc.headline, /Claude Code/)
  assert.match(cc.headline, /Haiku for quick answers, Sonnet for anything I do on your Mac/)
  assert.match(describeModels('api', DEFAULT_MODEL_CONFIG, true).headline, /Claude Opus 5\b/)
  assert.match(describeModels(null, DEFAULT_MODEL_CONFIG, false).headline, /No thinking model/)
})
