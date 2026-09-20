import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseQuery, distinctiveWords } from '../src/runtime/tools/search.js'

test('a kind of file becomes a filter, not a search word', () => {
  const q = parseQuery('find the ethernet frames pdf')
  assert.deepEqual(q.words, ['ethernet', 'frames'])
  assert.ok(q.extensions.includes('.pdf'))
  // "pdf" must not also be searched for as text, or every mention of the word
  // in any document outranks the actual PDF.
  assert.ok(!q.words.includes('pdf'))
})

test('a time is a filter, not a search word', () => {
  const q = parseQuery('the invoice I downloaded yesterday')
  assert.deepEqual(q.words, ['invoice'])
  assert.ok(q.modifiedAfter !== null)
  assert.equal(q.folder, 'Downloads')
})

test('"downloaded" points at the Downloads folder', () => {
  assert.equal(parseQuery('my latest downloaded file').folder, 'Downloads')
  assert.equal(parseQuery('what did I download today').folder, 'Downloads')
  assert.equal(parseQuery('the thing on my desktop').folder, 'Desktop')
})

test('a request naming nothing at all becomes a recency query', () => {
  const q = parseQuery('my latest downloaded file')
  assert.equal(q.recencyOnly, true)
  assert.deepEqual(q.words, [])
  // Sweeping a whole home directory by date is slow and meaningless; it is
  // scoped to somewhere obvious instead.
  assert.equal(q.folder, 'Downloads')
  assert.ok(q.modifiedAfter !== null)
})

test('a request naming something is not a recency query', () => {
  const q = parseQuery('find the organon of medicine pdf')
  assert.equal(q.recencyOnly, false)
  assert.deepEqual(q.words, ['organon', 'medicine'])
})

test('screenshots map to image extensions', () => {
  const q = parseQuery('the screenshot from today')
  assert.ok(q.extensions.includes('.png'))
  assert.ok(q.modifiedAfter !== null)
  assert.deepEqual(q.words, [])
})

test('filler words are dropped, distinctive ones kept', () => {
  assert.deepEqual(distinctiveWords('please find the file I saved about cybersecurity'), ['cybersecurity'])
  assert.deepEqual(distinctiveWords('open the invoice'), ['invoice'])
})

test('identity document wording recognizes spelling variants and removes machine filler', () => {
  for (const query of ['find my aadhar card in my pc', 'find my adhar card', 'where is my Aadhaar', 'find my आधार card']) {
    const parsed = parseQuery(query)
    assert.ok(parsed.words.includes('aadhaar'), query)
    assert.ok(parsed.words.includes('aadhar'), query)
    assert.ok(!parsed.words.includes('pc') && !parsed.words.includes('card'), query)
    assert.equal(parsed.recencyOnly, false)
    assert.equal(parsed.modifiedAfter, null)
  }
})

test('document vocabulary supports other names without treating cooking pans as IDs', () => {
  assert.ok(parseQuery('find my CV').words.includes('resume'))
  assert.ok(parseQuery('find my driving license').words.includes('driving licence'))
  assert.ok(parseQuery('find my insurence policy').words.includes('insurance'))
  assert.deepEqual(parseQuery('find my frying pan photo').words, ['frying', 'pan'])
  assert.ok(distinctiveWords('find आधार').includes('आधार'))
})

test('metadata reads need no permission, contents still do', async () => {
  const { fileTools } = await import('../src/runtime/tools/files.js')
  const byName = Object.fromEntries(fileTools.map((t) => [t.name, t]))

  // Looking at a folder listing is what the user already sees in Finder.
  // Asking permission for it was most of why Kibu felt like an interrogation.
  for (const name of ['files_list', 'files_inspect', 'files_search', 'files_find']) {
    assert.deepEqual(byName[name]!.scopes({ path: '/x', root: '/x', terms: 'x' } as never), [], name)
  }
  // File contents go to a model, so that one still asks.
  assert.ok(byName.files_read!.scopes({ path: '/x' } as never).length > 0)
  // Writing always asks.
  assert.ok(byName.files_create_folder!.scopes({ path: '/x' } as never).length > 0)
})

test('a protected location is still refused, now that no scope check runs', async () => {
  const { fileTools } = await import('../src/runtime/tools/files.js')
  const list = fileTools.find((t) => t.name === 'files_list')!
  await assert.rejects(
    () => list.precondition!({ path: `${process.env.HOME}/.ssh` } as never, {} as never),
    /protected/i
  )
})
