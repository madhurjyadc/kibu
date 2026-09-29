import { Notification, shell } from 'electron'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OsAdapter } from '../../os/adapter.js'
import type { SetupGroup, SetupItem, SetupStatus } from '../../shared/protocol.js'
import type { Store } from './db.js'

/**
 * Everything Kibu can be allowed to do on this Mac, in one list.
 *
 * Onboarding walks through it and Settings shows it again. Reading a status
 * never triggers a macOS prompt; `request` is the only thing that does, and
 * only for the one item the person chose.
 */

interface Definition {
  id: string
  group: SetupGroup
  label: string
  purpose: string
  hint?: string
  /** For apps and browsers: the bundle id Apple Events are addressed to. */
  bundleId?: string
  /** For folders: the name under the home folder. */
  folder?: string
}

const JS_FROM_APPLE_EVENTS = 'To read and click in pages, also turn on View → Developer → Allow JavaScript from Apple Events in this browser.'

const DEFINITIONS: Definition[] = [
  { id: 'accessibility', group: 'control', label: 'Accessibility', purpose: 'Read what is in app windows, press their buttons, and see the text you have selected.' },
  { id: 'screen-recording', group: 'control', label: 'Screen Recording', purpose: 'Look at one window when an app has no readable controls. Only when a task needs it; nothing is recorded or kept.' },
  { id: 'app:com.apple.iCal', group: 'apps', label: 'Calendar', bundleId: 'com.apple.iCal', purpose: 'Read your agenda, find free time, and add events you ask for.' },
  { id: 'app:com.apple.reminders', group: 'apps', label: 'Reminders', bundleId: 'com.apple.reminders', purpose: 'List, add and complete reminders.' },
  { id: 'app:com.apple.Notes', group: 'apps', label: 'Notes', bundleId: 'com.apple.Notes', purpose: 'Search, read and save notes.' },
  { id: 'app:com.apple.mail', group: 'apps', label: 'Mail', bundleId: 'com.apple.mail', purpose: 'Open drafts for you to check and send. Kibu never sends mail itself.' },
  { id: 'app:com.apple.finder', group: 'apps', label: 'Finder', bundleId: 'com.apple.finder', purpose: 'See which files you have selected, so “these” means them.' },
  { id: 'app:com.apple.systemevents', group: 'apps', label: 'System Events', bundleId: 'com.apple.systemevents', purpose: 'See which apps are open, switch dark mode, and read your selection.' },
  { id: 'app:com.google.Chrome', group: 'browsers', label: 'Google Chrome', bundleId: 'com.google.Chrome', purpose: 'See your open tabs, read the page you are on, and open new tabs.', hint: JS_FROM_APPLE_EVENTS },
  { id: 'app:com.apple.Safari', group: 'browsers', label: 'Safari', bundleId: 'com.apple.Safari', purpose: 'See your open tabs, read the page you are on, and open new tabs.', hint: 'To read and click in pages, also turn on Safari → Settings → Advanced → Show features for web developers, then Develop → Allow JavaScript from Apple Events.' },
  { id: 'app:company.thebrowser.Browser', group: 'browsers', label: 'Arc', bundleId: 'company.thebrowser.Browser', purpose: 'See your open tabs, read the page you are on, and open new tabs.', hint: JS_FROM_APPLE_EVENTS },
  { id: 'app:com.brave.Browser', group: 'browsers', label: 'Brave', bundleId: 'com.brave.Browser', purpose: 'See your open tabs, read the page you are on, and open new tabs.', hint: JS_FROM_APPLE_EVENTS },
  { id: 'app:com.microsoft.edgemac', group: 'browsers', label: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac', purpose: 'See your open tabs, read the page you are on, and open new tabs.', hint: JS_FROM_APPLE_EVENTS },
  { id: 'folder:Desktop', group: 'folders', label: 'Desktop', folder: 'Desktop', purpose: 'Find, tidy and rename files on your Desktop when you ask.' },
  { id: 'folder:Documents', group: 'folders', label: 'Documents', folder: 'Documents', purpose: 'Find, tidy and rename files in Documents when you ask.' },
  { id: 'folder:Downloads', group: 'folders', label: 'Downloads', folder: 'Downloads', purpose: 'Find, tidy and rename files in Downloads when you ask.' },
  { id: 'notifications', group: 'alerts', label: 'Notifications', purpose: 'Tap you on the shoulder for reminders and when a focus timer ends.' }
]

/** Where each answer can be changed later. Fixed addresses, never built from input. */
const SETTINGS_PANES: Record<SetupGroup | 'accessibility' | 'screen-recording', string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  control: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  apps: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  browsers: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  folders: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  alerts: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
}

const ANSWERS_KEY = 'setup_answers'

export class Setup {
  constructor(
    private readonly os: OsAdapter,
    private readonly store: Store
  ) {}

  /** The whole list with current answers. Apps and browsers that are not installed are left out. */
  async list(): Promise<SetupItem[]> {
    const items = await Promise.all(DEFINITIONS.map((d) => this.status(d)))
    return items.filter((i) => i.status !== 'not-installed')
  }

  /** Asks for one item and reports where it landed. */
  async request(id: string): Promise<SetupItem> {
    const def = DEFINITIONS.find((d) => d.id === id)
    if (!def) throw new Error(`Unknown setup item: ${id}`)
    if (def.id === 'accessibility' || def.id === 'screen-recording') {
      // Both are switched on in System Settings; the helper opens the pane.
      await this.os.requestPermission(def.id)
      return this.status(def)
    }
    if (def.bundleId) {
      const status = await this.os.automationPermission(def.bundleId, true)
      if (status === 'granted' || status === 'denied') this.remember(def.id, status)
      return this.item(def, status === 'not-running' ? 'unknown' : status)
    }
    if (def.folder) {
      // Reading the folder is what makes macOS ask; the answer is the result.
      try {
        await readdir(join(homedir(), def.folder))
        this.remember(def.id, 'granted')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        this.remember(def.id, code === 'EPERM' || code === 'EACCES' ? 'denied' : 'unknown')
      }
      return this.status(def)
    }
    // Notifications: the first one shown is what makes macOS ask.
    if (Notification.isSupported()) {
      new Notification({ title: 'Kibu', body: 'This is how I’ll tap you on the shoulder for reminders.', silent: true }).show()
    }
    this.remember(def.id, 'asked')
    return this.status(def)
  }

  async openSettings(id: string): Promise<void> {
    const def = DEFINITIONS.find((d) => d.id === id)
    if (!def) throw new Error(`Unknown setup item: ${id}`)
    const pane = def.id === 'accessibility' || def.id === 'screen-recording' ? SETTINGS_PANES[def.id] : SETTINGS_PANES[def.group]
    await shell.openExternal(pane)
  }

  private async status(def: Definition): Promise<SetupItem> {
    try {
      if (def.id === 'accessibility' || def.id === 'screen-recording') {
        const perms = await this.os.getPermissions()
        const granted = perms.find((p) => p.permission === def.id)?.granted ?? false
        return this.item(def, granted ? 'granted' : 'not-asked')
      }
      if (def.bundleId) {
        const status = await this.os.automationPermission(def.bundleId, false)
        if (status === 'granted' || status === 'denied' || status === 'not-installed') {
          this.remember(def.id, status === 'not-installed' ? null : status)
          return this.item(def, status)
        }
        // macOS only answers for an app that is open; otherwise use the last answer seen.
        return this.item(def, this.answers()[def.id] ?? 'not-asked')
      }
      return this.item(def, this.answers()[def.id] ?? 'not-asked')
    } catch {
      return this.item(def, 'unknown')
    }
  }

  private item(def: Definition, status: SetupStatus): SetupItem {
    return { id: def.id, group: def.group, label: def.label, purpose: def.purpose, status, ...(def.hint ? { hint: def.hint } : {}) }
  }

  private answers(): Record<string, SetupStatus> {
    try {
      return JSON.parse(this.store.getSetting(ANSWERS_KEY) ?? '{}') as Record<string, SetupStatus>
    } catch {
      return {}
    }
  }

  private remember(id: string, status: SetupStatus | null): void {
    const answers = this.answers()
    if ((answers[id] ?? null) === status) return
    if (status === null) delete answers[id]
    else answers[id] = status
    this.store.setSetting(ANSWERS_KEY, JSON.stringify(answers))
  }
}

export function isSetupId(id: unknown): id is string {
  return typeof id === 'string' && DEFINITIONS.some((d) => d.id === id)
}
