import { DEFAULT_SETTINGS, type Settings } from '../../shared/protocol.js'

/** Retired defaults; Option+Space also opens ChatGPT's floating pet. */
const OLD_DEFAULT_SHORTCUTS = ['CommandOrControl+Shift+K', 'Alt+Space']

/** Apply new defaults without replacing a person's chosen mode or shortcut. */
export function settingsFromSaved(raw: string | null): Settings {
  if (!raw) return { ...DEFAULT_SETTINGS }
  try {
    const saved = JSON.parse(raw) as Partial<Settings>
    if (!saved.shortcutChosen && OLD_DEFAULT_SHORTCUTS.includes(saved.shortcut ?? '')) delete saved.shortcut
    if (!saved.petModeChosen) delete saved.petMode
    return { ...DEFAULT_SETTINGS, ...saved }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}
