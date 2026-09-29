import { useCallback, useEffect, useState } from 'react'
import type { SetupGroup, SetupItem, SetupStatus } from '../../../shared/protocol.js'
import { Status, type StatusKind } from './Dots.js'

export const GROUP_TITLES: Record<SetupGroup, string> = {
  control: 'Seeing and using apps',
  apps: 'Mac apps',
  browsers: 'Your browsers',
  folders: 'Folders',
  alerts: 'Alerts'
}

const ORDER: SetupGroup[] = ['control', 'apps', 'browsers', 'folders', 'alerts']

const STATUS: Record<SetupStatus, { kind: StatusKind; label: string }> = {
  granted: { kind: 'done', label: 'Allowed' },
  denied: { kind: 'failed', label: 'Denied' },
  'not-asked': { kind: 'stopped', label: 'Not yet' },
  asked: { kind: 'ask', label: 'Sent' },
  'not-installed': { kind: 'stopped', label: 'Not installed' },
  unknown: { kind: 'stopped', label: 'Not yet' }
}

/** Items the one-tap "Ask for all" may cover: each shows macOS's own dialog in place. */
export function asksInPlace(item: SetupItem): boolean {
  return item.group !== 'control' && (item.status === 'not-asked' || item.status === 'unknown')
}

/**
 * Keeps the permission list current. macOS answers some of these in System
 * Settings, away from Kibu, so while it is on screen the list re-reads itself.
 */
export function useSetup(poll = true): {
  items: SetupItem[]
  busy: string | null
  error: string | null
  request(id: string): Promise<void>
  requestAll(): Promise<void>
  openSettings(id: string): Promise<void>
} {
  const [items, setItems] = useState<SetupItem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => { setItems(await window.kibu.getSetup()) }, [])

  useEffect(() => {
    void refresh().catch(() => setError('Couldn’t read your Mac’s permissions.'))
    if (!poll) return
    const id = setInterval(() => { if (document.visibilityState === 'visible') void refresh().catch(() => {}) }, 2500)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(id); window.removeEventListener('focus', refresh) }
  }, [refresh, poll])

  const request = useCallback(async (id: string) => {
    setBusy(id); setError(null)
    try {
      const next = await window.kibu.requestSetup(id)
      setItems((all) => all.map((i) => i.id === id ? next : i))
    } catch (e) { setError(e instanceof Error ? e.message : 'macOS didn’t answer. Try again.') }
    finally { setBusy(null) }
  }, [])

  const requestAll = useCallback(async () => {
    // One at a time: macOS shows one permission dialog at a time anyway.
    for (const item of items.filter(asksInPlace)) await request(item.id)
    await refresh().catch(() => {})
  }, [items, request, refresh])

  const openSettings = useCallback(async (id: string) => {
    try { await window.kibu.openSetupSettings(id) } catch { setError('Couldn’t open System Settings.') }
  }, [])

  return { items, busy, error, request, requestAll, openSettings }
}

/** Every permission, grouped, each with its status and the one action that changes it. */
export function SetupList({ items, busy, onRequest, onOpenSettings, groups = ORDER, flat = false }: {
  items: SetupItem[]
  busy: string | null
  onRequest(id: string): void
  onOpenSettings(id: string): void
  groups?: SetupGroup[]
  /** One list with no group headings, for a short set that already has its own heading. */
  flat?: boolean
}): React.JSX.Element {
  return (
    <div className="setup-groups">
      {(flat ? [null] : groups).map((group) => {
        const rows = group ? items.filter((i) => i.group === group) : items
        if (!rows.length) return null
        return (
          <section className="setup-group" key={group ?? 'all'} aria-label={group ? GROUP_TITLES[group] : undefined}>
            {group && <h2>{GROUP_TITLES[group]}</h2>}
            <ul className="setup-list">
              {rows.map((item) => {
                const shown = STATUS[item.status]
                return (
                  <li className={`setup-row is-${item.status}`} key={item.id}>
                    <div className="setup-copy">
                      <strong>{item.label}</strong>
                      <span>{item.purpose}</span>
                      {item.hint && item.status === 'granted' && <em>{item.hint}</em>}
                    </div>
                    <Status kind={busy === item.id ? 'working' : shown.kind} label={busy === item.id ? 'Asking' : shown.label} />
                    {item.status === 'granted' ? <span className="setup-action-space" />
                      : item.status === 'denied'
                        ? <button className="setup-action" onClick={() => onOpenSettings(item.id)} aria-label={`Open System Settings for ${item.label}`}>Settings</button>
                        : <button className="setup-action is-allow" disabled={!!busy} onClick={() => onRequest(item.id)} aria-label={`Allow ${item.label}`}>
                            {item.group === 'alerts' ? 'Try it' : 'Allow'}
                          </button>}
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
