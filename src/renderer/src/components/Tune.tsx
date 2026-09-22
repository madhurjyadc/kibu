import { useEffect, useState } from 'react'
import type { PermissionStatus, Settings } from '../../../shared/protocol.js'

/**
 * Keys, habits and permissions — the only settings there are, written as
 * things Kibu is or isn't allowed to do rather than as a preferences screen.
 * `only="keys"` is what /keys shows.
 */
export function Tune({ only, onKeyChange }: { only?: 'keys'; onKeyChange(has: boolean): void }): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [perms, setPerms] = useState<PermissionStatus[]>([])
  const [anthropic, setAnthropic] = useState('')
  const [jev, setJev] = useState('')
  const [hasAnthropic, setHasAnthropic] = useState(false)
  const [hasJev, setHasJev] = useState(false)
  const [hasClaudeCode, setHasClaudeCode] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setSettings(await window.kibu.getSettings())
    setPerms(await window.kibu.getPermissions())
    const has = await window.kibu.hasApiKey()
    setHasAnthropic(has)
    setHasJev(await window.kibu.hasJevKey())
    setHasClaudeCode(await window.kibu.hasClaudeCode())
    onKeyChange(has)
  }

  useEffect(() => {
    void refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Couldn’t load settings.'))
  }, [])

  async function save(which: 'anthropic' | 'jev'): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const value = which === 'anthropic' ? anthropic : jev
      const ok = which === 'anthropic' ? await window.kibu.setApiKey(value.trim()) : await window.kibu.setJevKey(value.trim())
      if (!ok) throw new Error('This Mac couldn’t save the key to Keychain. Please try again.')
      if (which === 'anthropic') setAnthropic('')
      else setJev('')
      setNote('Saved securely in your macOS Keychain.')
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : 'Couldn’t save your key.') }
    finally { setSaving(false) }
  }

  async function update(next: Partial<Settings>): Promise<void> {
    try { setSettings(await window.kibu.setSettings(next)); onKeyChange(await window.kibu.canWork()) }
    catch (e) { setError(e instanceof Error ? e.message : 'Couldn’t update settings.') }
  }

  if (!settings) return <p className="pane-empty">{error || "Loading your preferences…"}</p>

  return (
    <div className="pane tune">
      {error && <p className="bad" role="alert">{error}</p>}
      <div className="setting-section">
        <h2>Connections</h2>
        {([{ name: 'Anthropic', id: 'anthropic', value: anthropic, set: setAnthropic, has: hasAnthropic }, { name: 'TypeSafe', id: 'jev', value: jev, set: setJev, has: hasJev }] as const).map((provider) => (
          <div className="key" key={provider.id}>
            <label htmlFor={`key-${provider.id}`}>{provider.name}</label>
            <input id={`key-${provider.id}`} type="password" placeholder={provider.has ? 'Connected' : 'API key'} value={provider.value}
              onChange={(e) => provider.set(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && provider.value.trim() && !saving && void save(provider.id)} />
            <button className="key-save" disabled={!provider.value.trim() || saving} onClick={() => void save(provider.id)}>Save</button>
          </div>
        ))}
        {hasClaudeCode && <label className="habit"><span>Use local Claude Code</span><input type="checkbox" checked={settings.useClaudeCode} onChange={(e) => void update({ useClaudeCode: e.target.checked })} /></label>}
        {note && <p className="ok" role="status">Saved to Keychain.</p>}
      </div>
      {only !== 'keys' && <>
        <div className="setting-section"><h2>Permissions</h2><ul className="perms">{perms.map((p) => <li key={p.permission}>
          <span title={p.purpose}>{p.permission.replace('-', ' ')}</span>
          {p.granted ? <span className="ok">Enabled</span> : <button onClick={async () => { try { await window.kibu.requestPermission(p.permission); await refresh() } catch (e) { setError(e instanceof Error ? e.message : 'Permission unavailable.') } }}>Enable</button>}
        </li>)}</ul></div>
        <details className="setting-section"><summary>Preferences</summary>
          <label className="habit"><span>Fast file workflows</span><input type="checkbox" checked={settings.workflowsFirst} onChange={(e) => void update({ workflowsFirst: e.target.checked })} /></label>
          <label className="habit"><span>Jev decisions</span><input type="checkbox" checked={settings.jevEnabled} onChange={(e) => void update({ jevEnabled: e.target.checked })} /></label>
          <label className="habit"><span>Little chats from Kibu</span><input type="checkbox" checked={settings.chatty} onChange={(e) => void update({ chatty: e.target.checked })} /></label>
          <label className="habit"><span>Confirm every action</span><input type="checkbox" checked={settings.confirmEveryAction} onChange={(e) => void update({ confirmEveryAction: e.target.checked })} /></label>
          <label className="row"><span>Budget / task ($)</span><input type="number" min={0.1} step={0.25} defaultValue={settings.maxUsdPerTask} onBlur={(e) => { const value = Number(e.target.value); if (Number.isFinite(value) && value >= 0.1) void update({ maxUsdPerTask: value }); else e.target.value = String(settings.maxUsdPerTask) }} /></label>
          <label className="row"><span>Shortcut</span><input defaultValue={settings.shortcut} onBlur={(e) => { if (e.target.value.trim()) void update({ shortcut: e.target.value }) }} /></label>
        </details>
        <details className="setting-section"><summary>Privacy & connections</summary><p className="dim">History stays on this Mac. Relevant task context goes to your model provider. Delete tasks from History to remove their saved data and undo records.</p><p className="dim">Anthropic handles open-ended tasks. TypeSafe assists quick file workflows. Local Claude Code uses your existing login. File search works without a model key.</p></details>
      </>}
    </div>
  )
}
