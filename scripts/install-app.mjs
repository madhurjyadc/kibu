// Builds Kibu.app on this Mac and puts it in Applications, then opens it.
//
//   npm run app
//
// An app built on the Mac it runs on is not quarantined, so Gatekeeper lets it
// open without an Apple Developer ID. It is signed ad hoc, which macOS ties to
// this exact build: after rebuilding, macOS may ask for its permissions again.
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('Kibu runs on Apple silicon Macs (M1 or later) only.')
  process.exit(1)
}
try {
  execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' })
} catch {
  console.error('Kibu needs Apple’s command line tools to build its macOS helper. Run:\n\n  xcode-select --install\n\nthen run this again.')
  process.exit(1)
}

run('npm', ['run', 'helper:build'])
run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--mac', '--dir',
  '-c.mac.notarize=false', '-c.mac.identity=-', '-c.mac.hardenedRuntime=false'], { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })

const built = join(root, 'dist', 'mac-arm64', 'Kibu.app')
if (!existsSync(built)) throw new Error(`the build did not produce ${built}`)

// /Applications when it is writable, otherwise the per-user Applications folder.
let apps = '/Applications'
try { accessSync(apps, constants.W_OK) } catch { apps = join(homedir(), 'Applications'); mkdirSync(apps, { recursive: true }) }
const target = join(apps, 'Kibu.app')

try { execFileSync('osascript', ['-e', 'tell application id "app.kibu.desktop" to quit'], { stdio: 'ignore' }) } catch { /* not running */ }
if (existsSync(target)) {
  console.log(`Replacing ${target}`)
  rmSync(target, { recursive: true, force: true })
}
run('ditto', [built, target])
run('open', [target])
console.log(`\nKibu is installed at ${target} and running. Press ⌥Space to open it.`)
console.log('To update later: git pull && npm install && npx install-electron --no && npm run app')
