import { useEffect, useRef, useState } from 'react'
import type { CodingAppStatus, Settings } from '../../../shared/protocol.js'
import { Sprite, type Mood } from './Sprite.js'
import { Icon, type IconName } from './Icon.js'
import { SetupList, asksInPlace, useSetup } from './Setup.js'
import { Keys, ShortcutKey } from './ShortcutKey.js'

/**
 * First run: a quick tour, one thing Kibu can do per card. Each card says it
 * in a line, shows a request you could type, and asks for exactly the
 * permissions that thing needs, right there. Every card can be skipped; the
 * whole tour is a minute, not a setup wizard.
 */

interface Card {
  id: string
  say: string
  mood: Mood
  icon: IconName
  line: string
  /** Something you could type, in your own words. */
  example?: string
  /** The permissions this card's feature uses. */
  asks?: string[]
}

const CARDS: Card[] = [
  { id: 'hello', say: 'Hi, I’m Kibu.', mood: 'wave', icon: 'spark', line: 'I do real work on your Mac when you ask, and only then. Here’s what I can do, one thing at a time.' },
  { id: 'think', say: 'How should I think?', mood: 'curious', icon: 'spark', line: 'Pick what I plan with. You can change it any time in Settings.' },
  { id: 'files', say: 'Files.', mood: 'happy', icon: 'folder', line: 'Find anything, tidy a messy folder, rename a batch to one pattern. You see a preview first, and every move can be undone.', example: 'Organize my Downloads folder', asks: ['folder:Downloads', 'folder:Desktop', 'folder:Documents'] },
  { id: 'day', say: 'Your day.', mood: 'listening', icon: 'clock', line: 'Calendar, reminders and notes, through the apps you already use. Mail only ever becomes a draft for you to send.', example: 'Remind me to call mom tomorrow at 7', asks: ['app:com.apple.iCal', 'app:com.apple.reminders', 'app:com.apple.Notes', 'app:com.apple.mail'] },
  { id: 'web', say: 'The web.', mood: 'reading', icon: 'search', line: 'Read the page you’re on, open tabs, and work on sites in your own browser while you watch. I ask before anything that sends, posts or buys.', example: 'Summarize this page', asks: ['app:com.google.Chrome', 'app:com.apple.Safari', 'app:company.thebrowser.Browser', 'app:com.brave.Browser', 'app:com.microsoft.edgemac'] },
  { id: 'apps', say: 'Other apps.', mood: 'determined', icon: 'screen', line: 'Read windows and press buttons in other apps, and use whatever you’ve selected. I never move your mouse or type for you.', example: 'Explain the error I just selected', asks: ['accessibility', 'screen-recording', 'app:com.apple.finder', 'app:com.apple.systemevents'] },
  { id: 'keep', say: 'Remember & remind.', mood: 'love', icon: 'list', line: 'Notes, tasks and a focus timer live with me. Tell me things once and I’ll remember them, only on this Mac.', example: 'Start a 25 minute focus timer', asks: ['notifications'] },
  { id: 'done', say: 'That’s it.', mood: 'celebrate', icon: 'check', line: '' }
]

const TRY = ['Organize my Downloads folder', 'What’s on my calendar tomorrow?', 'Remind me to stretch in 30 minutes']

export function Welcome({ onDone }: { onDone(compose?: string): void }): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const card = CARDS[index]!
  const setup = useSetup(true)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [apps, setApps] = useState<CodingAppStatus[]>([])
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [hasJev, setHasJev] = useState(false)
  const [jev, setJev] = useState('')
  const [useKey, setUseKey] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The panel is as tall as the card: a one-line card should not sit in a tall empty window.
  const page = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = page.current
    if (!el) return
    const measure = (): void => {
      const root = el.closest('.kibu')
      if (!root || !el.isConnected) return
      const chrome = [...root.querySelectorAll(':scope > .bar, :scope > .statusbar')].reduce((h, c) => h + (c as HTMLElement).offsetHeight, 0)
      void window.kibu.resizePanel(Math.min(640, Math.max(300, Math.ceil((el.offsetHeight + chrome + 34) / 20) * 20)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [index])

  useEffect(() => {
    void Promise.all([window.kibu.getSettings(), window.kibu.codingApps(), window.kibu.hasApiKey(), window.kibu.hasJevKey()])
      .then(([s, a, k, j]) => { setSettings(s); setApps(a); setHasKey(k); setHasJev(j) })
      .catch(() => setError('Couldn’t load your settings.'))
  }, [])
  useEffect(() => { setError(null) }, [index])

  const last = index === CARDS.length - 1
  const next = (): void => { if (!last) setIndex(index + 1) }
  // Enter moves on and arrows step, so the tour can be read without the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || document.querySelector('.shortcut-key.is-recording')) return
      if (e.key === 'ArrowRight' || (e.key === 'Enter' && !last)) { e.preventDefault(); next() }
      if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); setIndex(index - 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function update(change: Partial<Settings>): Promise<void> {
    try { setSettings(await window.kibu.setSettings(change)) }
    catch (e) { setError(e instanceof Error ? e.message : 'Couldn’t save that.') }
  }
  async function saveKey(): Promise<void> {
    try {
      if (!(await window.kibu.setApiKey(key.trim()))) throw new Error('This Mac couldn’t save the key to Keychain.')
      setKey(''); setHasKey(true); await update({ useClaudeCode: false })
    } catch (e) { setError(e instanceof Error ? e.message : 'Couldn’t save that key.') }
  }
  async function saveJev(): Promise<void> {
    try {
      if (!(await window.kibu.setJevKey(jev.trim()))) throw new Error('This Mac couldn’t save the key to Keychain.')
      setJev(''); setHasJev(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'Couldn’t save that key.') }
  }
  async function finish(compose?: string): Promise<void> {
    try { await window.kibu.setSettings({ onboarded: true }) } catch { /* setup can be rerun with /setup */ }
    onDone(compose)
  }

  const items = setup.items.filter((i) => card.asks?.includes(i.id))
  const pending = items.filter(asksInPlace)
  const thinking = settings?.useClaudeCode ? apps.find((a) => a.id === settings.codingApp)?.label ?? 'a coding app' : hasKey ? 'Claude Sonnet 5.5' : null

  async function allowCard(): Promise<void> {
    for (const item of pending) await setup.request(item.id)
  }

  return (
    <>
      <div className="bar welcome-bar">
        <div className="bar-face"><Sprite state="idle" mood={card.mood} size={46} /></div>
        <div className="welcome-title"><strong>{card.say}</strong><span>{index + 1} of {CARDS.length}</span></div>
        <ol className="welcome-steps" aria-label={`Card ${index + 1} of ${CARDS.length}`}>
          {CARDS.map((c, i) => <li key={c.id}><button aria-label={`Go to ${c.say}`} className={i < index ? 'is-done' : i === index ? 'is-now' : ''} onClick={() => setIndex(i)} /></li>)}
        </ol>
      </div>

      <main className="workspace welcome">
        <section className="welcome-page" key={card.id} ref={page}>
          {error && <div className="notice" role="alert"><span>{error}</span></div>}
          {card.line && <p className="welcome-lead">{card.line}</p>}

          {card.id === 'hello' && settings && <div className="welcome-open">
            <span>Open me from anywhere</span>
            <ShortcutKey value={settings.shortcut} onChange={(shortcut) => void update({ shortcut })} />
            <span className="welcome-or">or click my face in the menu bar</span>
          </div>}
          {card.id === 'hello' && <p className="welcome-note">That’s me on your desktop, too. Drag me anywhere, drop files on me, right-click me to play. If I’m ever in the way, Settings → The pet can tuck me into the corner or the menu bar.</p>}

          {card.id === 'think' && settings && <>
            <ul className="welcome-choices" role="radiogroup" aria-label="What Kibu thinks with">
              {apps.filter((a) => a.available).map((a) => {
                const on = settings.useClaudeCode && settings.codingApp === a.id
                return <li key={a.id}><button role="radio" aria-checked={on} className={`welcome-choice ${on ? 'is-on' : ''}`} onClick={() => { setUseKey(false); void update({ useClaudeCode: true, codingApp: a.id }) }}>
                  <span className="welcome-radio" /><span><strong>{a.label}</strong><em>Found on this Mac. Uses the login it already has. Nothing to paste or pay.</em></span>
                </button></li>
              })}
              <li><button role="radio" aria-checked={!settings.useClaudeCode && (hasKey || useKey)} className={`welcome-choice ${!settings.useClaudeCode && (hasKey || useKey) ? 'is-on' : ''}`} onClick={() => { setUseKey(true); void update({ useClaudeCode: false }) }}>
                <span className="welcome-radio" /><span><strong>Anthropic API key</strong><em>Claude Sonnet 5.5. You pay Anthropic per use; each task stops at ${settings.maxUsdPerTask.toFixed(2)}.</em></span>
              </button></li>
            </ul>
            {!settings.useClaudeCode && (useKey || hasKey) && <div className="key">
              <label htmlFor="welcome-key">Anthropic</label>
              <input id="welcome-key" type="password" placeholder={hasKey ? 'Saved in Keychain' : 'sk-ant-…'} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && void saveKey()} />
              <button className="key-save" disabled={!key.trim()} onClick={() => void saveKey()}>Save</button>
            </div>}
            {!settings.useClaudeCode && useKey && !hasKey && <button className="welcome-link" onClick={() => void window.kibu.openUrl('https://console.anthropic.com/settings/keys')}>Get a key from the Anthropic Console <Icon name="arrow" size={13} /></button>}
            {!thinking && <p className="welcome-note">Or skip this: finding, tidying and renaming files, reminders, calendar and notes work without either.</p>}

            <div className="welcome-jev">
              <h2>Jev · optional</h2>
              <p className="welcome-note">A TypeSafe key lets Jev make the quick calls (which folder, which calendar, which way to rename) in about a tenth of a second, for a fraction of a cent. Without it I use my own rules.</p>
              <div className="key">
                <label htmlFor="welcome-jev">TypeSafe</label>
                <input id="welcome-jev" type="password" placeholder={hasJev ? 'Saved in Keychain' : 'TypeSafe API key'} value={jev} onChange={(e) => setJev(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && jev.trim() && void saveJev()} />
                <button className="key-save" disabled={!jev.trim()} onClick={() => void saveJev()}>Save</button>
              </div>
            </div>
          </>}

          {card.example && <div className="welcome-example"><span className="rows-label">Try saying</span><p className="asked">{card.example}</p></div>}

          {items.length > 0 && <div className="welcome-asks">
            <div className="welcome-asks-head">
              <h2>{items.length === 1 ? 'Needs' : 'Needs your OK for'}</h2>
              {pending.length > 1 && <button className="welcome-secondary" disabled={!!setup.busy} onClick={() => void allowCard()}>Allow all {pending.length}</button>}
            </div>
            {setup.error && <div className="notice" role="alert"><span>{setup.error}</span></div>}
            <SetupList flat items={items} busy={setup.busy} onRequest={(id) => void setup.request(id)} onOpenSettings={(id) => void setup.openSettings(id)} />
          </div>}

          {card.id === 'done' && <>
            <ul className="welcome-summary">
              <li><span>Thinks with</span><strong>{thinking ?? 'Nothing yet. Files, reminders, calendar and notes only'}</strong></li>
              <li><span>Jev</span><strong>{hasJev ? 'On' : 'Off, using my own rules'}</strong></li>
              <li><span>Allowed</span><strong>{setup.items.filter((i) => i.status === 'granted').length} of {setup.items.length} permissions</strong></li>
            </ul>
            <p className="welcome-lead">Press <Keys accelerator={settings?.shortcut ?? 'Alt+Space'} /> and ask. A few to start with:</p>
            <ul className="rows">
              {TRY.map((t) => <li key={t}><button className="row-button" onClick={() => void finish(t)}><span className="row-icon"><Icon name="arrow" size={15} /></span><span className="row-title">{t}</span></button></li>)}
            </ul>
            <p className="welcome-note">Type <kbd>/setup</kbd> to see this again. Permissions live in Settings.</p>
          </>}
        </section>
      </main>

      <footer className="statusbar welcome-nav">
        {index > 0 ? <button className="text-button" onClick={() => setIndex(index - 1)}><Icon name="back" size={14} />Back</button>
          : <button className="text-button" onClick={() => void finish()}>Skip tour</button>}
        <span className="welcome-spacer" />
        {!last && index > 0 && <button className="text-button" onClick={() => void finish()}>Skip tour</button>}
        {last
          ? <button className="welcome-next" onClick={() => void finish()}>Start using Kibu</button>
          : <button className="welcome-next" onClick={next}>{index === 0 ? 'Show me' : 'Next'}<Icon name="arrow" size={14} /></button>}
      </footer>
    </>
  )
}
