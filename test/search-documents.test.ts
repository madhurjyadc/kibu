import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm, utimes, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findFiles, parseQuery } from '../src/runtime/tools/search.js'

test('Aadhaar misspelling retrieves the named document instead of unrelated recent cards', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kibu-doc-search-')))
  try {
    await writeFile(join(root, 'e-Aadhaar.pdf'), 'synthetic test fixture')
    await utimes(join(root, 'e-Aadhaar.pdf'), new Date('2020-01-01'), new Date('2020-01-01'))
    await writeFile(join(root, 'birthday-card.pdf'), 'unrelated')
    await writeFile(join(root, 'pc-invoice.pdf'), 'unrelated')
    await writeFile(join(root, 'insurance.pdf'), 'unrelated')
    const query = parseQuery('find my aadhar card in my pc')
    const results = await findFiles({ root, terms: query.words.join(' '), limit: 8 })
    assert.equal(results[0]?.name, 'e-Aadhaar.pdf')
    assert.ok(!results.some((r) => r.name === 'birthday-card.pdf' || r.name === 'pc-invoice.pdf'))
    const exact = await findFiles({ root: join(root, 'e-Aadhaar.pdf'), terms: 'aadhar', limit: 8 })
    assert.equal(exact[0]?.name, 'e-Aadhaar.pdf', 'a dropped file is a valid search scope')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fallback skips noisy directories and finds alternate document names', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kibu-doc-fallback-')))
  try {
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'aadhaar.pdf'), 'noise')
    await mkdir(join(root, 'Documents'))
    await writeFile(join(root, 'Documents', 'my_resume.pdf'), 'fixture')
    const matches = await findFiles({ root, terms: parseQuery('find my CV').words.join(' '), limit: 8 })
    assert.equal(matches[0]?.name, 'my_resume.pdf')
    const missing = await findFiles({ root, terms: 'aadhar', limit: 8 })
    assert.deepEqual(missing, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
