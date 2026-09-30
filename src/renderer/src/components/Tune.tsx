import { useEffect, useState } from 'react'
import type { CodingAppStatus, Memory, Settings } from '../../../shared/protocol.js'
import { SetupList, useSetup } from './Setup.js'
import { ShortcutKey } from './ShortcutKey.js'

/**
 * Keys, habits and permissions: the only settings there are, written as
 * things Kibu is or isn't allowed to do rather than as a preferences screen.
 * `only="keys"` is what /keys shows.
 */
export function Tune({ only, onKeyChange, onSetup }: { only?: 'keys'; onKeyChange(has: boolean): void; onSetup?(): void }): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const setup = useSetup(only !== 'keys')
  const [anthropic, setAnthropic] = useState('')
  const [jev, setJev] = useState('')
  const [hasAnthropic, setHasAnthropic] = useState(false)
  const [hasJev, setHasJev] = useState(false)
  const [apps, setApps] = useState<CodingAppStatus[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setSettings(await window.kibu.getSettings())
    const has = await window.kibu.hasApiKey()
    setHasAnthropic(has)
    setHasJev(await window.kibu.hasJevKey())
    setApps(await window.kibu.codingApps())
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
        {apps.some((a) => a.available) && <>
          <label className="habit"><span>Plan with a coding app on this Mac</span><input type="checkbox" checked={settings.useClaudeCode} onChange={(e) => void update({ useClaudeCode: e.target.checked })} /></label>
          {settings.useClaudeCode && <label className="row"><span>Coding app</span><select aria-label="Coding app" value={settings.codingApp} onChange={(e) => void update({ codingApp: e.target.value as Settings['codingApp'] })}>
            {apps.map((a) => <option key={a.id} value={a.id} disabled={!a.available}>{a.label}{a.available ? '' : ' (not installed)'}</option>)}
          </select></label>}
          {settings.useClaudeCode && settings.codingApp !== 'claude-code' && <label className="row"><span>Model</span><input key={settings.codingApp} aria-label="Coding app model"
            placeholder={settings.codingApp === 'opencode' ? 'provider/model, or its default' : 'Its own default'}
            defaultValue={settings.codingApp === 'codex' ? settings.codexModel : settings.opencodeModel}
            onBlur={(e) => void update(settings.codingApp === 'codex' ? { codexModel: e.target.value } : { opencodeModel: e.target.value }).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Couldn’t save that model.'))} /></label>}
        </>}
        {note && <p className="ok" role="status">Saved to Keychain.</p>}
      </div>
      {only !== 'keys' && <>
        <details className="setting-section" open={setup.items.some((i) => i.status !== 'granted' && i.group === 'control')}>
          <summary>Permissions · {setup.items.filter((i) => i.status === 'granted').length} of {setup.items.length} allowed</summary>
          {setup.error && <p className="bad" role="alert">{setup.error}</p>}
          <SetupList items={setup.items} busy={setup.busy} onRequest={(id) => void setup.request(id)} onOpenSettings={(id) => void setup.openSettings(id)} />
          {onSetup && <button className="welcome-link" onClick={onSetup}>Run setup again <span aria-hidden="true">→</span></button>}
        </details>
        <MemorySection settings={settings} update={update} onError={setError} />
        <details className="setting-section"><summary>Preferences</summary>
          <label className="habit"><span>Open Kibu at login for reminders</span><input type="checkbox" checked={settings.launchAtLogin ?? false} onChange={(e) => void update({ launchAtLogin: e.target.checked })} /></label>
          <label className="habit"><span>Fast file workflows</span><input type="checkbox" checked={settings.workflowsFirst} onChange={(e) => void update({ workflowsFirst: e.target.checked })} /></label>
          <label className="habit"><span>Jev decisions</span><input type="checkbox" checked={settings.jevEnabled} onChange={(e) => void update({ jevEnabled: e.target.checked })} /></label>
          <label className="habit"><span>Little chats from Kibu</span><input type="checkbox" checked={settings.chatty} onChange={(e) => void update({ chatty: e.target.checked })} /></label>
          <label className="habit"><span>Confirm every action</span><input type="checkbox" checked={settings.confirmEveryAction} onChange={(e) => void update({ confirmEveryAction: e.target.checked })} /></label>
          <label className="row"><span>Budget / task ($)</span><input type="number" min={0.1} step={0.25} defaultValue={settings.maxUsdPerTask} onBlur={(e) => { const value = Number(e.target.value); if (Number.isFinite(value) && value >= 0.1) void update({ maxUsdPerTask: value }); else e.target.value = String(settings.maxUsdPerTask) }} /></label>
          <div className="row"><span>Open Kibu</span><ShortcutKey value={settings.shortcut} onChange={(shortcut) => void update({ shortcut })} /></div>
          <label className="row"><span>The pet</span><select aria-label="Where the pet lives" value={settings.petMode ?? 'desktop'} onChange={(e) => void update({ petMode: e.target.value as Settings['petMode'] })}>
            <option value="desktop">Always on the desktop</option>
            <option value="peek">Only while working (peeks from the corner)</option>
            <option value="menubar">Menu bar only</option>
          </select></label>
        </details>
        <details className="setting-section"><summary>Privacy & connections</summary><p className="dim">History stays on this Mac. Relevant task context goes to your model provider. Delete tasks from History to remove their saved data and undo records.</p><p className="dim">Anthropic handles open-ended tasks. TypeSafe assists quick file workflows. Claude Code, Codex or OpenCode on this Mac use your existing login, and Kibu keeps their conversations in its own history rather than theirs. File search works without a model key.</p></details>
      </>}
    </div>
  )
}

/**
 * What Kibu remembers, in the person's own words, with a way to drop any of
 * it. Memory that cannot be seen or deleted is not something to trust.
 */
function MemorySection({ settings, update, onError }: { settings: Settings; update(next: Partial<Settings>): Promise<void>; onError(message: string): void }): React.JSX.Element {
  const [memories, setMemories] = useState<Memory[]>([])
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    void window.kibu.listMemories().then(setMemories).catch(() => {})
    return window.kibu.onMemoriesChanged(setMemories)
  }, [])

  async function drop(id: string): Promise<void> {
    try { setMemories(await window.kibu.deleteMemory(id)) } catch { onError('Couldn’t forget that one.') }
  }

  async function clearAll(): Promise<void> {
    try { setMemories(await window.kibu.clearMemories()); setConfirming(false) } catch { onError('Couldn’t clear memory.') }
  }

  const told = memories.filter((m) => m.source === 'told')
  const learned = memories.filter((m) => m.source === 'learned')
  const group = (label: string, items: Memory[]): React.JSX.Element | null =>
    items.length ? (
      <>
        <p className="memory-group">{label}</p>
        <ul className="memories">
          {items.map((m) => (
            <li key={m.id}>
              <span title={m.uses ? `Used ${m.uses} time${m.uses === 1 ? '' : 's'}` : 'Not used yet'}>{m.text}</span>
              <button aria-label={`Forget: ${m.text}`} onClick={() => void drop(m.id)}>Forget</button>
            </li>
          ))}
        </ul>
      </>
    ) : null

  return (
    <details className="setting-section" open={memories.length > 0 && memories.length <= 8}>
      <summary>Memory{memories.length ? ` · ${memories.length}` : ''}</summary>
      <label className="habit"><span>Remember things about me</span><input type="checkbox" checked={settings.memoryEnabled} onChange={(e) => void update({ memoryEnabled: e.target.checked })} /></label>
      <label className="habit"><span>Learn from what I do</span><input type="checkbox" disabled={!settings.memoryEnabled} checked={settings.memoryEnabled && settings.memoryLearn} onChange={(e) => void update({ memoryLearn: e.target.checked })} /></label>
      {memories.length === 0 ? (
        <p className="dim">Nothing yet. Say “remember that …”, or just use Kibu: it picks up the choices you repeat. It only brings a memory up when it helps with what you asked.</p>
      ) : (
        <>
          {group('You told me', told)}
          {group('I picked up', learned)}
          <div className="memory-actions">
            {confirming ? (
              <>
                <span className="dim">Forget all {memories.length}?</span>
                <button className="bad" onClick={() => void clearAll()}>Forget everything</button>
                <button onClick={() => setConfirming(false)}>Keep</button>
              </>
            ) : (
              <button onClick={() => setConfirming(true)}>Forget everything</button>
            )}
          </div>
        </>
      )}
      <p className="dim">Kept only on this Mac. Passwords, codes and card numbers are never remembered.</p>
    </details>
  )
}
