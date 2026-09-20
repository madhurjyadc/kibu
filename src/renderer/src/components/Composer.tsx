import { useEffect, useRef, useState } from 'react'
import { basename } from '../lib/paths.js'
import type { FrontWindow } from '../../../shared/protocol.js'

interface Props {
  droppedPaths: string[]
  placeholder: string
  onSubmit(text: string, includeFrontWindow: boolean): void | Promise<void>
  onClearDropped(): void
}

const SUGGESTIONS = [
  'Organise my Downloads folder by project',
  'Find the PDF I downloaded yesterday and open it',
  'Rename these files consistently'
]

export function Composer({ droppedPaths, placeholder, onSubmit, onClearDropped }: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [front, setFront] = useState<FrontWindow | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
    // What the user was in before this panel opened — the target of
    // "help me with this window".
    void window.kibu.getFrontWindow().then(setFront)
  }, [])

  // Grow the box with the text instead of scrolling a two-line field.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])

  function send(includeFrontWindow = false): void {
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    void onSubmit(trimmed, includeFrontWindow)
  }

  return (
    <div className="composer">
      {droppedPaths.length > 0 && (
        <div className="chips">
          {droppedPaths.slice(0, 4).map((p) => (
            <span className="chip" key={p} title={p}>
              {basename(p)}
            </span>
          ))}
          {droppedPaths.length > 4 && <span className="chip muted">+{droppedPaths.length - 4} more</span>}
          <button className="chip clear" onClick={onClearDropped}>
            clear
          </button>
        </div>
      )}
      <textarea
        id="composer"
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send(false)
          }
          if (e.key === 'Escape') void window.kibu.closePanel()
        }}
      />
      <div className="composer-foot">
        {text.length === 0 && droppedPaths.length === 0 ? (
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => setText(s)}>
                {s}
              </button>
            ))}
          </div>
        ) : (
          <span className="hint">Enter to send · Shift+Enter for a new line</span>
        )}
        {front && (
          <button
            className="with-window"
            onClick={() => send(true)}
            disabled={!text.trim()}
            title={front.title || front.name}
          >
            Use {front.name}
          </button>
        )}
        <button className="send" onClick={() => send(false)} disabled={!text.trim()}>
          Send
        </button>
      </div>
    </div>
  )
}
