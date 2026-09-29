// Renders the macOS app icon (build/icon.icns) from Kibu's idle sprite: the
// same face the website uses as its favicon, set on a black glass tile.
//
//   node scripts/make-app-icon.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const root = new URL('..', import.meta.url).pathname
const sprite = readFileSync(join(root, 'website/dist/assets/kibu-idle.svg'), 'utf8')
const out = join(root, 'build')
mkdirSync(out, { recursive: true })

// Apple's grid: an 824px tile centred on a 1024px canvas, leaving room for the shadow.
const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:1024px;height:1024px;display:grid;place-items:center">
  <div style="width:824px;height:824px;border-radius:185px;display:grid;place-items:center;
    background:radial-gradient(120% 90% at 50% 0%,#1d1e22 0%,#0b0b0d 60%,#050506 100%);
    box-shadow:inset 0 0 0 2px rgba(255,255,255,.08),0 18px 40px rgba(0,0,0,.45)">
    <div style="width:620px">${sprite.replace(/width="\d+" height="\d+"/, 'width="620" height="579"')}</div>
  </div>
</div></body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
await page.setContent(html)
const png = join(out, 'icon.png')
await page.screenshot({ path: png, omitBackground: true })
await browser.close()

const set = join(out, 'icon.iconset')
rmSync(set, { recursive: true, force: true })
mkdirSync(set)
for (const size of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', String(size), String(size), png, '--out', join(set, `icon_${size}x${size}.png`)], { stdio: 'ignore' })
  execFileSync('sips', ['-z', String(size * 2), String(size * 2), png, '--out', join(set, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' })
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', join(out, 'icon.icns')])
rmSync(set, { recursive: true, force: true })
writeFileSync(join(out, '.icon-source'), 'website/dist/assets/kibu-idle.svg\n')
console.log('wrote build/icon.png and build/icon.icns')
