import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import electronUpdater from 'electron-updater'

const SIX_HOURS = 6 * 60 * 60 * 1000

/**
 * Keeps an installed Kibu current from the project's GitHub releases.
 *
 * An update downloads in the background and is applied the next time Kibu
 * quits; macOS shows a notification when one is ready. Only a signed,
 * packaged release build can update itself; development runs and copies
 * built from the source skip all of this.
 */
export function startUpdateChecks(log: (message: string) => void): void {
  // A copy built from the source (npm run app) has no release feed: it is
  // updated with git pull and a rebuild, not from GitHub releases.
  if (!app.isPackaged || !existsSync(join(process.resourcesPath, 'app-update.yml'))) return
  const { autoUpdater } = electronUpdater
  autoUpdater.logger = null
  autoUpdater.on('error', (err: Error) => log(`update check failed: ${err.message}`))
  autoUpdater.on('update-downloaded', (info: { version: string }) => log(`Kibu ${info.version} is ready and installs when Kibu quits`))
  const check = (): void => {
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => log(`update check failed: ${err instanceof Error ? err.message : String(err)}`))
  }
  check()
  setInterval(check, SIX_HOURS).unref()
}
