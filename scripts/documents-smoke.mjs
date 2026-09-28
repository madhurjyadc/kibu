/** Real native extraction and conversion against synthetic documents only. */
import { chromium } from 'playwright'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { readDocumentText, prepareDocuments, searchDocuments } from '../dist-test/src/runtime/tools/documents.js'
import { emptyAuthorization } from '../dist-test/src/shared/types.js'
const dir = await mkdtemp(join(tmpdir(), 'kibu-documents-'))
process.env.KIBU_HELPER_PATH = resolve('resources/bin/kibu-helper')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.setContent('<html><body style="padding:60px;font:28px Arial"><h1>ACME Invoice 1042</h1><p>Website redesign</p><p>Amount: INR 12,500</p><p>Due: 30 September 2026</p></body></html>')
  const pdf = join(dir, 'invoice.pdf'), png = join(dir, 'scan.png')
  await page.pdf({ path: pdf }); await page.screenshot({ path: png })
  const original = await readFile(pdf)
  const text = await readDocumentText(pdf)
  assert.match(text.pages[0].text, /ACME Invoice 1042/)
  const ocr = await readDocumentText(png)
  assert.match(ocr.pages[0].text, /ACME Invoice 1042/)
  assert.equal(ocr.pages[0].ocr, true)
  const ctx = { task: { authorization: { ...emptyAuthorization(), readRoots: [dir], writeRoots: [dir] } }, checkpoint: async () => {}, progress: () => {} }
  const input = prepareDocuments.input.parse({ paths: [png, pdf], outputFolder: dir, format: 'pdf', maxBytes: 2000000 })
  const out = await prepareDocuments.execute(input, ctx)
  assert.equal((await prepareDocuments.verify(input, out, ctx)).verified, true)
  assert.equal(out.result.outputs.length, 2)
  for (const output of out.result.outputs) assert.ok((await stat(output.path)).size <= 2000000)
  assert.deepEqual(await readFile(pdf), original)
  const result = await searchDocuments.execute({ folder: dir, query: 'ACME Invoice', maxFiles: 4 }, ctx)
  const realPng = await realpath(png), realPdf = await realpath(pdf)
  assert.ok(result.result.matches.some(m => m.path === realPng && m.ocr))
  assert.ok(result.result.matches.some(m => m.path === realPdf))
  console.log('Native document checks passed: PDF text, image OCR, size-bounded PDF copies, content search, originals preserved.')
} finally { await browser.close(); await rm(dir, { recursive: true, force: true }) }
