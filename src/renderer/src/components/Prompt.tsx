import { useEffect, useRef, useState } from 'react'
import type { FrontWindow, PetState } from '../../../shared/protocol.js'
import { basename } from '../lib/paths.js'
import { Icon } from './Icon.js'

/** Everything Kibu can be told to do that isn't a task. */
export const COMMANDS = [
  { name: 'undo', hint: 'Undo file changes' },
  { name: 'steps', hint: 'Task details' },
  { name: 'past', hint: 'History' },
  { name: 'stop', hint: 'Stop task' },
  { name: 'keys', hint: 'Connections' },
  { name: 'tune', hint: 'Settings' },
  { name: 'bench', hint: 'Diagnostics' },
  { name: 'help', hint: 'Shortcuts' }
] as const

export type CommandName = (typeof COMMANDS)[number]['name']

interface Props {
  state: PetState
  placeholder: string
  /** A task is running: plain requests wait, commands still go through. */
  busy: boolean
  dropped: string[]
  front: FrontWindow | null
  onClearDropped(): void
  onAttach(): Promise<void>
  canAnswer?: boolean
  seed?: { text: string; id: number } | null
  onSend(text: string, withFront: boolean): Promise<void>
  onCommand(name: string): void
  /** Returns true when the digit was consumed (e.g. picking an answer). */
  onNumber?(n: number): boolean
  onEscape(): void
}

/** A persistent composer: preserve drafts on failure and support answers as well as new tasks. */
export function Prompt({
  placeholder,
  busy,
  canAnswer = false,
  seed,
  dropped,
  front,
  onClearDropped,
  onAttach,
  onSend,
  onCommand,
  onNumber,
  onEscape
}: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [pick, setPick] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [withFront, setWithFront] = useState(false)
  const submitLock = useRef(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  const slash = text.startsWith('/')
  const query = slash ? text.slice(1).trim().toLowerCase() : ''
  const matches = slash ? COMMANDS.filter((c) => c.name.startsWith(query)) : []

  useEffect(() => {
    ref.current?.focus()
  }, [])

  useEffect(() => {
    setPick(0)
  }, [query])

  useEffect(() => {
    if (seed) { setText(seed.text); setError(null); ref.current?.focus() }
  }, [seed])

  // The line grows with what is being typed instead of scrolling.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }, [text])

  async function run(includeFront: boolean): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || submitLock.current) return
    if (trimmed.startsWith('/')) {
      const chosen = matches[pick] ?? matches[0]
      if (!chosen) { setError('No matching shortcut. Try /help.'); return }
      setText('')
      onCommand(chosen.name)
      return
    }
    if (busy && !canAnswer) return
    submitLock.current = true
    setSubmitting(true)
    setError(null)
    try {
      await onSend(trimmed, includeFront)
      setText('')
      setWithFront(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t send that. Your draft is still here.')
    } finally { setSubmitting(false); submitLock.current = false }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      if (text) setText('')
      else onEscape()
      return
    }
    if (!text && onNumber && /^[1-9]$/.test(e.key) && onNumber(Number(e.key))) {
      e.preventDefault()
      return
    }
    if (!text && e.key === 'Backspace' && dropped.length > 0) {
      e.preventDefault()
      onClearDropped()
      return
    }
    if (matches.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
      return
    }
    if (matches.length > 0 && e.key === 'Tab') {
      e.preventDefault()
      setText(`/${(matches[pick] ?? matches[0])!.name}`)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void run((e.altKey || withFront) && !!front && !canAnswer)
    }
  }

  return (
    <>
      <div className={`prompt ${busy ? 'busy' : ''}`}>
        <button className="icon-button attach-button" aria-label="Attach files" title="Attach files" onClick={() => void onAttach()}><Icon name="plus" size={19} /></button>
        <textarea
          id="composer"
          aria-label={canAnswer ? "Answer Kibu" : "Ask Kibu for help"}
          disabled={submitting}
          maxLength={4000}
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        {front && !canAnswer && !busy && (
          <button
            className={`context-toggle ${withFront ? 'on' : ''}`}
            aria-label={`Include ${front.name}`}
            title={`${withFront ? 'Remove' : 'Include'} ${front.name} context (⌥Enter)`}
            aria-pressed={withFront}
            onClick={() => setWithFront(!withFront)}
          >
            <Icon name="screen" size={14} />

          </button>
        )}
        <button
          className="send-button"
          aria-label={canAnswer ? 'Send answer' : 'Send task'}
          disabled={!text.trim() || submitting || (busy && !canAnswer && !slash)}
          onClick={() => void run(withFront && !!front && !canAnswer)}
        >
          <Icon name="arrow" size={19} />
        </button>
      </div>

      {error && <p className="composer-error" role="alert">{error}</p>}

      {dropped.length > 0 && (
        <div className="chips">
          {dropped.slice(0, 5).map((p) => (
            <span className="chip" key={p} title={p}>
              {basename(p)}
            </span>
          ))}
          {dropped.length > 5 && <span className="chip dim">+{dropped.length - 5}</span>}
          <button className="chip x" onClick={onClearDropped} title="Remove attached files" aria-label="Remove attached files">
            ×
          </button>
        </div>
      )}

      {matches.length > 0 && (
        <ul className="palette">
          {matches.map((c, i) => (
            <li
              key={c.name}
              className={i === pick ? 'on' : ''}
              onMouseEnter={() => setPick(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                setText('')
                onCommand(c.name)
              }}
            >
              <span className="cmd">/{c.name}</span>
              <span className="cmd-hint">{c.hint}</span>
              {i === pick && <kbd className="row-key">↩</kbd>}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
