import { useEffect, useRef, useState } from 'react'
import { validCodingModel, type CodingApp, type CodingModel, type CodingModelCatalog, type Settings } from '../../../shared/protocol.js'

export function codingModelSetting(app: CodingApp): 'claudeCodeModel' | 'codexModel' | 'opencodeModel' {
  return app === 'claude-code' ? 'claudeCodeModel' : app === 'codex' ? 'codexModel' : 'opencodeModel'
}

/** Choosing is a draft; an explicit check confirms access before replacing the saved model. */
export function ModelPicker({ app, value, onChange }: { app: CodingApp; value: string; onChange(change: Partial<Settings>): Promise<void> }): React.JSX.Element {
  const [catalog, setCatalog] = useState<CodingModelCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [search, setSearch] = useState('')
  const [freeOnly, setFreeOnly] = useState(false)
  const [custom, setCustom] = useState(false)
  const [choice, setChoice] = useState(value)
  const [draft, setDraft] = useState(value)
  const [checking, setChecking] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const [checks, setChecks] = useState<Record<string, { access: 'verified' | 'unavailable'; reason: string }>>({})
  const alive = useRef(true)
  const busy = useRef(false)
  const savedValue = useRef(value)
  savedValue.current = value
  const name = app === 'codex' ? 'Codex' : app === 'opencode' ? 'OpenCode' : 'Claude Code'

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let active = true
    setLoading(true); setError(''); setCatalog(null); setChecks({}); setFeedback('')
    void window.kibu.codingModels(app, refresh > 0).then((next) => { if (active) setCatalog(next) })
      .catch(() => { if (active) setError(`Couldn’t load ${name} models. Check its installation and login, then refresh, or enter a model ID.`) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [app, refresh])
  useEffect(() => { setChoice(value); setDraft(value) }, [value])

  const models = (catalog?.models ?? []).map((model) => checks[model.id] ? { ...model, ...checks[model.id] } : model)
  const recommended = models.find((model) => model.recommended && model.access !== 'unavailable')
  const pending = custom ? draft.trim() : choice
  const selected = models.find((model) => model.id === pending)
  const access = checks[pending] || selected
  const visible = models.filter((model) => (!freeOnly || model.free === true) && `${model.label} ${model.id}`.toLowerCase().includes(search.toLowerCase().trim()))
  const keepChoice = choice && !visible.some((model) => model.id === choice)
  const valid = validCodingModel(pending) && (app !== 'opencode' || !pending || (pending.includes('/') && !pending.startsWith('/') && !pending.endsWith('/')))
  const label = (model: CodingModel): string => `${model.label}${model.free ? ' · Free' : ''}${model.access === 'unavailable' ? ' · Unavailable' : model.access === 'verified' ? ' · Access checked' : model.recommended ? ' · Recommended' : ''}`

  function choose(id: string): void {
    if (busy.current) return
    setChoice(id); setCustom(false); setFeedback('')
  }

  async function checkAndSave(): Promise<void> {
    if (busy.current || !valid || access?.access === 'unavailable') return
    const model = pending
    const original = savedValue.current
    busy.current = true; setChecking(true); setFeedback(''); setFailed(false)
    try {
      if (model) {
        const result = await window.kibu.checkCodingModel(app, model)
        if (!alive.current || savedValue.current !== original) return
        if (!result.ok) {
          setFailed(true); setFeedback(result.message)
          if (result.unavailable) setChecks((old) => ({ ...old, [model]: { access: 'unavailable', reason: result.message } }))
          return
        }
        setChecks((old) => ({ ...old, [model]: { access: 'verified', reason: result.message } }))
      }
      if (!alive.current || savedValue.current !== original) return
      await onChange({ [codingModelSetting(app)]: model })
      if (!alive.current) return
      setChoice(model)
      setFeedback(model ? 'Access checked and model saved for Kibu.' : 'Kibu will use your coding app’s configured default.')
    } catch {
      if (alive.current) { setFailed(true); setFeedback('Couldn’t check or save this model. Your previous choice is still selected. Please retry.') }
    } finally {
      busy.current = false
      if (alive.current) setChecking(false)
    }
  }

  return (
    <div className="model-picker" aria-label={`${name} model selection`}>
      <div className="model-picker-top"><strong>Model · {name}</strong><button type="button" className="welcome-link" disabled={loading || checking} onClick={() => setRefresh((n) => n + 1)}>Refresh models</button></div>
      {catalog?.connection && <p className="model-connection">{catalog.connection}</p>}
      {recommended && <div className="model-recommendation"><div><strong>Recommended · {recommended.label}</strong><p className="dim">{recommended.recommendation || `${name} recommends this model for your connection.`}</p></div><button type="button" className="welcome-link" disabled={checking} onClick={() => choose(recommended.id)}>Choose recommended</button></div>}
      <label className="model-search"><span className="sr-only">Search {name} models</span><input type="search" value={search} placeholder="Search models" onChange={(e) => setSearch(e.target.value)} /></label>
      {app === 'opencode' && <label className="habit"><span>Show free models only</span><input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /></label>}
      <label className="model-choice"><span className="sr-only">{name} model</span><select aria-label={`${name} model`} value={choice} aria-busy={checking} data-unavailable={(checks[choice] || models.find((model) => model.id === choice))?.access === 'unavailable'} onChange={(e) => choose(e.target.value)}>
        {app !== 'claude-code' && <option value="">Use configured default{catalog?.defaultModel ? ` · ${catalog.defaultModel}` : ''}</option>}
        {keepChoice && <option value={choice} disabled={models.find((model) => model.id === choice)?.access === 'unavailable'}>{models.find((model) => model.id === choice)?.label || choice} · {choice === value ? 'saved choice' : 'pending choice'}</option>}
        {visible.map((model) => <option key={model.id} value={model.id} disabled={model.access === 'unavailable'} title={model.reason}>{label(model)}</option>)}
      </select></label>
      {loading ? <p className="dim" role="status">Loading {name} models…</p>
        : error ? <p className="bad" role="alert">{error}</p>
          : !models.length ? <p className="dim">No models were listed. Set up {name}, refresh, or enter a model ID.</p>
            : !visible.length ? <p className="dim">{freeOnly ? 'No matching models with confirmed free pricing.' : 'No matching models.'}</p> : null}
      {selected?.description && <p className="dim">{selected.description}</p>}
      <button type="button" className="welcome-link" aria-expanded={custom} disabled={checking} onClick={() => { setCustom((open) => !open); setFeedback('') }}>Enter a model ID</button>
      {custom && <div className="model-custom"><label><span className="sr-only">Custom {name} model ID</span><input aria-label={`Custom ${name} model ID`} value={draft} readOnly={checking} placeholder={app === 'opencode' ? 'provider/model' : 'Exact model ID'} onChange={(e) => { setDraft(e.target.value); setFeedback('') }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (draft.trim()) void checkAndSave() } }} /></label></div>}
      {custom && pending && !valid && <p className="bad">{app === 'opencode' ? 'Use a provider/model ID without spaces.' : 'Use an exact model ID without spaces (up to 256 characters).'}</p>}
      {access?.access === 'unavailable' && <p className="bad" role="alert">{access.reason} Refresh models after your access changes.</p>}
      <div className="model-apply"><button type="button" className="key-save" disabled={checking || !valid || access?.access === 'unavailable' || (custom && !pending) || (!pending && app === 'claude-code')} onClick={() => void checkAndSave()}>{checking ? 'Checking access…' : pending ? 'Check & use model' : 'Use configured default'}</button><span className="dim">Saved: {value || 'configured default'}</span></div>
      {pending && <p className="dim">Checking sends one short test reply. It may use included quota or incur provider charges. Models that haven’t been checked may still be restricted by your plan.</p>}
      {feedback && !(failed && access?.access === 'unavailable' && feedback === access.reason) && <p className={failed ? 'bad' : 'model-success'} role={failed ? 'alert' : 'status'}>{feedback}</p>}
      <p className="dim">{catalog?.note || 'Uses your existing connection. Model access, provider charges and usage limits still apply.'}</p>
      <p className="dim">Coding-app charges are handled by your provider. Kibu’s per-task dollar cap does not cover this connection.</p>
      {models.some((model) => model.access === 'unavailable') && <details className="model-unavailable"><summary>Why are some models unavailable?</summary><ul>{models.filter((model) => model.access === 'unavailable').map((model) => <li key={model.id}><strong>{model.label}</strong><span>{model.reason}</span></li>)}</ul></details>}
      {app === 'opencode' && <p className="dim">Model choices are saved for Kibu. Your coding project’s settings stay as they are.</p>}
    </div>
  )
}
