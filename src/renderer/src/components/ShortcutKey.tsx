import { useEffect, useState } from 'react'

/** Symbol and name together: "⌥" alone is easy to misread as ⌘, Spotlight's key. */
const SYMBOL: Record<string, string> = {
  CommandOrControl: '⌘ Command', CmdOrCtrl: '⌘ Command', Command: '⌘ Command', Cmd: '⌘ Command', Super: '⌘ Command',
  Alt: '⌥ Option', Option: '⌥ Option', Shift: '⇧ Shift', Control: '⌃ Control', Ctrl: '⌃ Control'
}

/** "Alt+Space" → ["⌥ Option", "Space"]: the keys as a Mac keyboard labels them. */
export function shortcutKeys(accelerator: string): string[] {
  return accelerator.split('+').map((part) => SYMBOL[part] ?? (part.length === 1 ? part.toUpperCase() : part))
}

/** The key a keydown names, in Electron's accelerator spelling, or null for a bare modifier. */
function keyOf(e: KeyboardEvent): string | null {
  if (['Meta', 'Alt', 'Shift', 'Control'].includes(e.key)) return null
  if (e.code === 'Space') return 'Space'
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3)
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5)
  if (/^F\d{1,2}$/.test(e.code)) return e.code
  return null
}

export function Keys({ accelerator }: { accelerator: string }): React.JSX.Element {
  return <span className="keys">{shortcutKeys(accelerator).map((k, i) => <span key={i}>{i > 0 && <i>+</i>}<kbd>{k}</kbd></span>)}</span>
}

/**
 * The shortcut, shown as keys; click it and press a new chord to change it.
 * A chord needs ⌘, ⌥ or ⌃, so ordinary typing can never be taken over.
 */
export function ShortcutKey({ value, onChange }: { value: string; onChange(accelerator: string): void }): React.JSX.Element {
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') { setRecording(false); return }
      const key = keyOf(e)
      if (!key || !(e.metaKey || e.altKey || e.ctrlKey)) return
      // ⌘Space belongs to Spotlight: pressing it here opens Spotlight, not this.
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && key === 'Space') return
      const parts = [e.metaKey && 'Command', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean) as string[]
      setRecording(false)
      onChange(parts.join('+'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onChange])

  return (
    <button className={`shortcut-key ${recording ? 'is-recording' : ''}`} onClick={() => setRecording(!recording)}
      aria-label={recording ? 'Press the new shortcut, or Escape to keep this one' : `Shortcut ${shortcutKeys(value).join(' ')}. Click to change`}>
      {recording ? <span className="shortcut-listening">Press keys…</span> : <Keys accelerator={value} />}
    </button>
  )
}
