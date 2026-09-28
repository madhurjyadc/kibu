import { useEffect, useState } from 'react'

/*
 * Kibu's one glyph language, outside the face: the same dots spell out a
 * clock on its TV screen and in the workspace, and a status in 5 × 5.
 */

type Glyph = readonly string[]

/** 3 × 5 digits, as on a cheap LED clock. */
const DIGITS: Record<string, Glyph> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  ':': ['.', '#', '.', '#', '.'],
  h: ['#..', '#..', '###', '#.#', '#.#']
}

export interface Cell { col: number; row: number; on: boolean; colon: boolean }

/** A clock string laid out on a 5-row dot grid, one blank column between glyphs. */
export function dotText(text: string): { cols: number; cells: Cell[] } {
  const cells: Cell[] = []
  let col = 0
  for (const ch of text) {
    const glyph = DIGITS[ch]
    if (!glyph) continue
    const width = glyph[0]!.length
    for (let r = 0; r < 5; r++) for (let c = 0; c < width; c++) cells.push({ col: col + c, row: r, on: glyph[r]![c] === '#', colon: ch === ':' })
    col += width + 1
  }
  return { cols: Math.max(0, col - 1), cells }
}

/** Minutes and seconds under an hour; hours and minutes above, so it always fits. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** A dot-matrix clock for the panel, drawn like the TV's screen. */
export function DotClock({ ms, tone = 'on', pitch = 4 }: { ms: number; tone?: 'on' | 'idle' | 'paused' | 'ringing'; pitch?: number }): React.JSX.Element {
  const text = clockText(ms)
  const { cols, cells } = dotText(text)
  const r = pitch * 0.36
  return (
    <svg className={`dot-clock is-${tone}`} width={cols * pitch} height={5 * pitch} viewBox={`0 0 ${cols * pitch} ${5 * pitch}`} role="img" aria-label={text}>
      {cells.map((c, i) => <circle key={i} className={c.on ? (c.colon ? 'lit colon' : 'lit') : 'unlit'} cx={c.col * pitch + pitch / 2} cy={c.row * pitch + pitch / 2} r={c.on ? r : r * 0.6} />)}
    </svg>
  )
}

export type StatusKind = 'ready' | 'working' | 'ask' | 'paused' | 'done' | 'failed' | 'stopped'

/** 5 × 5 status marks. "working" is drawn as a sweeping scanner in CSS. */
const MARKS: Record<StatusKind, Glyph> = {
  ready: ['.....', '.#.#.', '.....', '#...#', '.###.'],
  working: ['#####', '#####', '#####', '#####', '#####'],
  ask: ['.###.', '#...#', '..##.', '.....', '..#..'],
  paused: ['.#.#.', '.#.#.', '.#.#.', '.#.#.', '.#.#.'],
  done: ['.....', '....#', '...#.', '#.#..', '.#...'],
  failed: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  stopped: ['.....', '.###.', '.###.', '.###.', '.....']
}

export function DotGlyph({ kind }: { kind: StatusKind }): React.JSX.Element {
  const glyph = MARKS[kind]
  return (
    <svg className={`dot-glyph is-${kind}`} width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      {glyph.flatMap((row, r) => [...row].map((ch, c) => (
        <rect key={`${r}-${c}`} x={c * 2.6 + 0.3} y={r * 2.6 + 0.3} width="2" height="2" rx=".4"
          className={ch === '#' ? 'lit' : 'unlit'} style={kind === 'working' ? { animationDelay: `${c * 120}ms` } : undefined} />
      )))}
    </svg>
  )
}

/** One status, everywhere: a tiny dot glyph, a word, and an optional quiet detail. */
export function Status({ kind, label, detail, className = '' }: { kind: StatusKind; label: string; detail?: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <span className={`status is-${kind} ${className}`}>
      <DotGlyph kind={kind} />
      <span className="status-label">{label}</span>
      {detail && <span className="status-detail">{detail}</span>}
    </span>
  )
}

/** What a task's runtime status looks like to a person. */
export function taskStatus(status: string): { kind: StatusKind; label: string } {
  switch (status) {
    case 'pending': return { kind: 'working', label: 'Starting' }
    case 'observing': return { kind: 'working', label: 'Looking' }
    case 'planning': return { kind: 'working', label: 'Thinking' }
    case 'verifying': return { kind: 'working', label: 'Checking' }
    case 'awaiting_user': return { kind: 'ask', label: 'Needs you' }
    case 'paused': return { kind: 'paused', label: 'Paused' }
    case 'succeeded': return { kind: 'done', label: 'Done' }
    case 'failed': return { kind: 'failed', label: 'Didn’t finish' }
    case 'cancelled': return { kind: 'stopped', label: 'Stopped' }
    default: return { kind: 'working', label: 'Working' }
  }
}

/** Time since a moment, ticking by itself so its parent does not re-render. */
export function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return <>{s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}</>
}
