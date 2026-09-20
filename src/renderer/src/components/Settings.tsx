import { useEffect, useState } from 'react'
import type { PermissionStatus, Settings } from '../../../shared/protocol.js'

export function SettingsView({ onKeyChange }: { onKeyChange(has: boolean): void }): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [permissions, setPermissions] = useState<PermissionStatus[]>([])
  const [keyInput, setKeyInput] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [jevInput, setJevInput] = useState('')
  const [hasJevKey, setHasJevKey] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setSettings(await window.kibu.getSettings())
    setPermissions(await window.kibu.getPermissions())
    const has = await window.kibu.hasApiKey()
    setHasKey(has)
    setHasJevKey(await window.kibu.hasJevKey())
    onKeyChange(has)
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function saveKey(): Promise<void> {
    const ok = await window.kibu.setApiKey(keyInput)
    setKeyInput('')
    setSaved(ok ? 'Key saved to your Keychain.' : 'Could not use the system keychain on this machine.')
    await refresh()
  }

  async function saveJevKey(): Promise<void> {
    const ok = await window.kibu.setJevKey(jevInput)
    setJevInput('')
    setSaved(ok ? 'Jev key saved to your Keychain.' : 'Could not use the system keychain on this machine.')
    await refresh()
  }

  async function update(next: Partial<Settings>): Promise<void> {
    setSettings(await window.kibu.setSettings(next))
  }

  if (!settings) return <p className="muted pad">Loading…</p>

  return (
    <div className="settings">
      <section>
        <h3>Anthropic API key</h3>
        <p className="muted">
          For the planning model, which handles open-ended requests. Optional if you only want the common file tasks
          Jev can do on its own. Stored encrypted in the macOS Keychain, never sent anywhere except Anthropic.
        </p>
        <div className="row">
          <input
            type="password"
            placeholder={hasKey ? 'A key is saved — enter a new one to replace it' : 'sk-ant-…'}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button className="primary" onClick={saveKey} disabled={!keyInput.trim()}>
            Save
          </button>
        </div>
        {saved && <p className="saved">{saved}</p>}
      </section>

      <section>
        <h3>TypeSafe API key (Jev)</h3>
        <p className="muted">
          A separate service from the planning model. Jev is TypeSafe AI's System One model, which Kibu uses for fast
          structured decisions. With a Jev key, common file tasks run without touching the planning model at all.
          Without either key, Kibu cannot run a task; without Jev alone, it falls back to local rules.
        </p>
        <div className="row">
          <input
            type="password"
            placeholder={hasJevKey ? 'A key is saved — enter a new one to replace it' : 'TypeSafe API key'}
            value={jevInput}
            onChange={(e) => setJevInput(e.target.value)}
          />
          <button className="primary" onClick={saveJevKey} disabled={!jevInput.trim()}>
            Save
          </button>
        </div>
        <p className="muted">
          Jev never decides whether an action is allowed and never decides a task succeeded. It can only make Kibu more
          cautious, never less.
        </p>
      </section>

      <section>
        <h3>macOS permissions</h3>
        <p className="muted">
          These are separate from what you allow Kibu to do in a task. Kibu asks for them only when a task needs the
          capability.
        </p>
        <ul className="perms">
          {permissions.map((p) => (
            <li key={p.permission}>
              <div>
                <span className={`badge ${p.granted ? 'on' : 'off'}`}>{p.granted ? 'Granted' : 'Not granted'}</span>
                <strong>{p.permission.replace('-', ' ')}</strong>
                <p className="muted">{p.purpose}</p>
              </div>
              {!p.granted && (
                <button
                  onClick={async () => {
                    await window.kibu.requestPermission(p.permission)
                    await refresh()
                  }}
                >
                  Grant
                </button>
              )}
            </li>
          ))}
          {permissions.length === 0 && <li className="muted">No permission information available on this platform.</li>}
        </ul>
      </section>

      <section>
        <h3>Limits</h3>
        <label className="row">
          <span>Spending limit per task</span>
          <input
            type="number"
            min={0.1}
            step={0.25}
            value={settings.maxUsdPerTask}
            onChange={(e) => void update({ maxUsdPerTask: Number(e.target.value) })}
          />
        </label>
        <label className="row">
          <span>Global shortcut</span>
          <input value={settings.shortcut} onChange={(e) => void update({ shortcut: e.target.value })} />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.workflowsFirst}
            onChange={(e) => void update({ workflowsFirst: e.target.checked })}
          />
          <span>
            Do common tasks with Jev alone
            <small>
              Organising a folder, finding a file and renaming files run on local code plus Jev, with no planning-model
              call. Much faster and cheaper. Anything else still uses the planner.
            </small>
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.jevEnabled}
            onChange={(e) => void update({ jevEnabled: e.target.checked })}
          />
          <span>
            Use Jev for fast structured decisions
            <small>Off means routing and grouping use local rules only. Needs a TypeSafe API key.</small>
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.confirmEveryAction}
            onChange={(e) => void update({ confirmEveryAction: e.target.checked })}
          />
          <span>
            Confirm every action
            <small>Slower, but nothing happens without a prompt.</small>
          </span>
        </label>
      </section>

      <section>
        <h3>Your data</h3>
        <p className="muted">
          Tasks, history and preferences stay on this Mac in a local database. Kibu sends only the context a step needs
          to the model — it does not index your disk or upload screenshots continuously, and captures are temporary.
        </p>
      </section>
    </div>
  )
}
