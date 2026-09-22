import { useEffect, useId, useState } from 'react'
import type { PetState } from '../../../shared/protocol.js'

export interface Look { x: number; y: number }

/**
 * Everything Kibu can show. Runtime state picks a default (see MOOD_FOR);
 * the pet window layers the moment-to-moment ones — being hovered, dragged,
 * fed a file, left alone — on top.
 */
export type Mood =
  | 'idle' | 'happy' | 'excited' | 'listening' | 'curious' | 'thinking' | 'working' | 'straining'
  | 'waiting' | 'proud' | 'sad' | 'oops' | 'sleepy' | 'dizzy' | 'love' | 'surprised' | 'wink'
  | 'wave' | 'laugh' | 'shy' | 'bored' | 'yawn' | 'cool' | 'starstruck' | 'music' | 'reading'
  | 'skeptical' | 'nervous' | 'celebrate' | 'kiss' | 'pout' | 'sneeze' | 'determined'

/** Every mood, in the order the expression sheet shows them. */
export const MOODS: Mood[] = [
  'idle', 'happy', 'excited', 'listening', 'curious', 'thinking', 'working', 'straining', 'waiting', 'proud', 'sad',
  'oops', 'sleepy', 'dizzy', 'love', 'surprised', 'wink', 'wave', 'laugh', 'shy', 'bored', 'yawn', 'cool',
  'starstruck', 'music', 'reading', 'skeptical', 'nervous', 'celebrate', 'kiss', 'pout', 'sneeze', 'determined'
]

export const MOOD_FOR: Record<PetState, Mood> = {
  idle: 'idle', listening: 'listening', thinking: 'thinking', working: 'working',
  waiting: 'waiting', finished: 'proud', failed: 'sad'
}

/*
 * Kibu is a small obsidian pebble with a dot-matrix face. The display is the
 * whole personality: 15 × 11 dots that draw eyes and a mouth, and double as a
 * status readout — a scanner while it works, a question mark when it needs
 * you. One glyph language carries both emotion and information.
 */
const COLS = 15
const ROWS = 11

type Glyph = readonly string[]
const EYE: Record<string, Glyph> = {
  open: ['.#.', '###', '###', '.#.'],
  blink: ['...', '...', '###', '...'],
  arc: ['.#.', '#.#', '...', '...'],
  wide: ['###', '#.#', '#.#', '###'],
  focus: ['...', '###', '###', '...'],
  sadL: ['...', '##.', '###', '.#.'],
  sadR: ['...', '.##', '###', '.#.'],
  cross: ['#.#', '.#.', '#.#', '...'],
  heart: ['#.#', '###', '.#.', '...'],
  ringA: ['###', '#.#', '###', '...'],
  ringB: ['.#.', '#.#', '.#.', '...'],
  gtL: ['#..', '.#.', '#..', '...'],
  ltR: ['..#', '.#.', '..#', '...'],
  lid: ['...', '...', '###', '.#.'],
  star: ['.+.', '+++', '.+.', '...'],
  down: ['...', '...', '.#.', '###'],
  none: ['...', '...', '...', '...']
}
const MOUTH: Record<string, Glyph> = {
  smile: ['.....', '#...#', '.###.'],
  grin: ['#####', '#...#', '.###.'],
  o: ['.....', '..#..', '.....'],
  bigO: ['.###.', '#...#', '.###.'],
  side: ['.....', '...##', '.##..'],
  tongue: ['.....', '#...#', '.#+#.'],
  frown: ['.....', '.###.', '#...#'],
  wobbleA: ['.....', '#.#.#', '.#.#.'],
  wobbleB: ['.....', '.#.#.', '#.#.#'],
  flat: ['.....', '.###.', '.....'],
  sleepA: ['.....', '..#..', '.....'],
  sleepB: ['.....', '.###.', '.....'],
  none: ['.....', '.....', '.....'],
  kiss: ['..#..', '...#.', '..#..'],
  pout: ['.....', '.###.', '.#.#.'],
  tiny: ['.....', '.##..', '.....'],
  smirk: ['.....', '....#', '.###.'],
  laughA: ['#####', '#+++#', '.###.'],
  laughB: ['.....', '#####', '.###.']
}
const MARK: Record<string, Glyph> = {
  question: ['###', '..#', '.##', '...', '.#.'],
  bang: ['.#.', '.#.', '.#.', '...', '.#.'],
  z: ['###', '.#.', '###'],
  spark: ['.#.', '#.#', '.#.'],
  heart: ['#.#', '###', '.#.'],
  note: ['.##', '.#.', '##.'],
  hand: ['#.#', '###', '.#.']
}

type Cell = 'on' | 'accent'
type Grid = Map<number, Cell>

function stamp(grid: Grid, glyph: Glyph, col: number, row: number, tone: Cell = 'on', mirror = false): void {
  glyph.forEach((line, dy) => {
    for (let dx = 0; dx < line.length; dx++) {
      const ch = mirror ? line[line.length - 1 - dx] : line[dx]
      if (ch === '.' || ch === undefined) continue
      const c = col + dx
      const r = row + dy
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue
      grid.set(r * COLS + c, ch === '+' ? 'accent' : tone)
    }
  })
}

interface Face {
  eyes: [string, string]
  mouth: string
  tracks: boolean
  accent: string
  extra?: (g: Grid, t: number) => void
  /** Where the eyes look over time, for moods whose gaze is part of the feeling. */
  gaze?: (t: number) => [number, number]
  /** A mouth that changes over time: yawning, laughing, sneezing. */
  mouthAt?: (t: number) => string
  eyesAt?: (t: number) => [string, string]
}

/** Draws a run of dots — brows, sunglasses, confetti trails. */
function dots(g: Grid, cells: [number, number][], tone: Cell = 'on'): void {
  for (const [c, r] of cells) if (c >= 0 && c < COLS && r >= 0 && r < ROWS) g.set(r * COLS + c, tone)
}
const blush = (g: Grid): void => dots(g, [[1, 6], [2, 6], [12, 6], [13, 6]], 'accent')

const LIME = '#d4ff3a'
const AMBER = '#ffb23e'
const RED = '#ff5a4e'
const PINK = '#ff6fa8'
const ICE = '#8fb4ff'

/** A three-dot bar sweeping the bottom row: "busy", without words. */
const scanner = (g: Grid, t: number): void => {
  const span = COLS - 3
  const k = t % (span * 2)
  const at = k < span ? k : span * 2 - k
  for (let i = 0; i < 3; i++) g.set((ROWS - 1) * COLS + at + i, 'accent')
}
const sparkles = (g: Grid, t: number): void => {
  if (t % 2 === 0) stamp(g, MARK.spark!, 0, 0, 'accent')
  else stamp(g, MARK.spark!, 12, 0, 'accent')
}
const sweat = (g: Grid, t: number): void => { g.set(((t % 3) + 1) * COLS + 13, 'accent') }

const FACES: Record<Mood, Face> = {
  idle: { eyes: ['open', 'open'], mouth: 'smile', tracks: true, accent: LIME },
  happy: { eyes: ['arc', 'arc'], mouth: 'grin', tracks: false, accent: LIME },
  excited: { eyes: ['wide', 'wide'], mouth: 'bigO', tracks: false, accent: LIME, extra: sparkles },
  listening: { eyes: ['open', 'open'], mouth: 'o', tracks: true, accent: ICE },
  curious: { eyes: ['wide', 'open'], mouth: 'side', tracks: true, accent: ICE },
  thinking: {
    eyes: ['open', 'open'], mouth: 'none', tracks: false, accent: ICE,
    extra: (g, t) => { for (let i = 0; i <= t % 4 && i < 3; i++) g.set(8 * COLS + 5 + i * 2, 'on') }
  },
  working: { eyes: ['focus', 'focus'], mouth: 'flat', tracks: true, accent: LIME, extra: scanner },
  straining: { eyes: ['focus', 'focus'], mouth: 'wobbleA', tracks: false, accent: AMBER, extra: (g, t) => { scanner(g, t); sweat(g, t) } },
  waiting: { eyes: ['wide', 'wide'], mouth: 'o', tracks: true, accent: AMBER, extra: (g, t) => { if (t % 4 !== 3) stamp(g, MARK.question!, 12, 0, 'accent') } },
  proud: { eyes: ['arc', 'arc'], mouth: 'grin', tracks: false, accent: LIME, extra: sparkles },
  sad: { eyes: ['sadL', 'sadR'], mouth: 'frown', tracks: false, accent: RED, extra: (g, t) => { g.set((6 + (t % 3)) * COLS + 3, 'accent') } },
  oops: { eyes: ['gtL', 'ltR'], mouth: 'wobbleA', tracks: false, accent: AMBER, extra: sweat },
  sleepy: { eyes: ['blink', 'blink'], mouth: 'sleepA', tracks: false, accent: ICE, extra: (g, t) => stamp(g, MARK.z!, 12, 2 - (t % 3), 'accent') },
  dizzy: { eyes: ['ringA', 'ringA'], mouth: 'wobbleA', tracks: false, accent: AMBER },
  love: { eyes: ['heart', 'heart'], mouth: 'grin', tracks: false, accent: PINK, extra: (g, t) => { if (t % 2) stamp(g, MARK.heart!, 12, 0, 'accent') } },
  surprised: { eyes: ['wide', 'wide'], mouth: 'bigO', tracks: false, accent: AMBER, extra: (g) => stamp(g, MARK.bang!, 12, 0, 'accent') },
  wink: { eyes: ['open', 'blink'], mouth: 'side', tracks: false, accent: LIME },

  // Hello: happy eyes and a little hand going side to side.
  wave: { eyes: ['arc', 'arc'], mouth: 'grin', tracks: false, accent: LIME, extra: (g, t) => stamp(g, MARK.hand!, t % 2 ? 12 : 11, t % 2 ? 4 : 5, 'accent') },
  // Squeezed eyes, open mouth, happy tears.
  laugh: {
    eyes: ['gtL', 'ltR'], mouth: 'laughA', tracks: false, accent: ICE,
    mouthAt: (t) => (t % 2 ? 'laughB' : 'laughA'),
    extra: (g, t) => dots(g, [[1, 5 + (t % 3)], [13, 5 + ((t + 1) % 3)]], 'accent')
  },
  // Looks down and away, cheeks lit.
  shy: { eyes: ['down', 'down'], mouth: 'tiny', tracks: false, accent: PINK, gaze: () => [-1, 0], extra: blush },
  // Half-lidded, glancing about for something to do.
  bored: { eyes: ['lid', 'lid'], mouth: 'flat', tracks: false, accent: ICE, gaze: (t) => [[0, -1, 0, 1][t % 4]!, 0] },
  // A slow, wide yawn.
  yawn: {
    eyes: ['gtL', 'ltR'], mouth: 'o', tracks: false, accent: ICE,
    mouthAt: (t) => ['o', 'bigO', 'bigO', 'bigO', 'o', 'flat'][t % 6]!,
    eyesAt: (t) => (t % 6 < 4 ? ['gtL', 'ltR'] : ['blink', 'blink'])
  },
  // Sunglasses on, smirk.
  cool: {
    eyes: ['none', 'none'], mouth: 'smirk', tracks: false, accent: LIME,
    extra: (g, t) => {
      dots(g, [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [11, 2], [12, 2]])
      dots(g, [[3, 3], [4, 3], [5, 3], [9, 3], [10, 3], [11, 3], [4, 4], [10, 4]])
      if (t % 5 === 0) dots(g, [[5, 3]], 'accent')
    }
  },
  // Star eyes and sparkles: "that was amazing".
  starstruck: { eyes: ['star', 'star'], mouth: 'bigO', tracks: false, accent: '#ffe066', extra: sparkles },
  // Eyes closed, humming, a note drifting up.
  music: { eyes: ['arc', 'arc'], mouth: 'smile', tracks: false, accent: LIME, extra: (g, t) => stamp(g, MARK.note!, 12, 3 - (t % 4), 'accent') },
  // Eyes sweeping along a line of text.
  reading: { eyes: ['focus', 'focus'], mouth: 'flat', tracks: false, accent: ICE, gaze: (t) => [[-1, 0, 1, 1][t % 4]!, [0, 0, 0, 1][t % 4]!] },
  // One brow up.
  skeptical: {
    eyes: ['open', 'focus'], mouth: 'side', tracks: false, accent: ICE,
    extra: (g) => dots(g, [[3, 1], [4, 1], [5, 1], [9, 0], [10, 0], [11, 1]])
  },
  // Wide eyes darting, wobbly mouth, sweat.
  nervous: { eyes: ['wide', 'wide'], mouth: 'wobbleA', tracks: false, accent: AMBER, gaze: (t) => [t % 2 ? -1 : 0, 0], extra: sweat },
  // Confetti falling over a big grin.
  celebrate: {
    eyes: ['arc', 'arc'], mouth: 'grin', tracks: false, accent: LIME,
    extra: (g, t) => {
      for (const [c, off] of [[0, 0], [2, 3], [7, 1], [12, 2], [14, 4], [5, 5]] as const) dots(g, [[c, (t + off) % 6]], 'accent')
    }
  },
  // A wink and a kiss.
  kiss: { eyes: ['open', 'arc'], mouth: 'kiss', tracks: false, accent: PINK, extra: (g, t) => { if (t % 2) stamp(g, MARK.heart!, 12, 5, 'accent') } },
  // Brows down, lip out.
  pout: {
    eyes: ['open', 'open'], mouth: 'pout', tracks: false, accent: RED, gaze: () => [1, 0],
    extra: (g) => dots(g, [[3, 1], [4, 1], [5, 2], [9, 2], [10, 1], [11, 1]])
  },
  // Ah… ah… choo.
  sneeze: {
    eyes: ['focus', 'focus'], mouth: 'o', tracks: false, accent: ICE,
    eyesAt: (t) => (t % 6 < 3 ? ['focus', 'focus'] : t % 6 < 5 ? ['gtL', 'ltR'] : ['blink', 'blink']),
    mouthAt: (t) => (t % 6 < 3 ? 'o' : t % 6 < 5 ? 'bigO' : 'flat'),
    extra: (g, t) => { if (t % 6 === 4) dots(g, [[1, 7], [0, 8], [2, 9], [13, 7], [14, 8], [12, 9]], 'accent') }
  },
  // "On it": brows set, a small confident smile.
  determined: {
    eyes: ['focus', 'focus'], mouth: 'smirk', tracks: true, accent: LIME,
    extra: (g) => dots(g, [[3, 1], [4, 2], [5, 2], [9, 2], [10, 2], [11, 1]])
  }
}

/** Moods whose picture changes over time, and how fast. */
const FRAME_MS: Partial<Record<Mood, number>> = {
  working: 90, straining: 70, thinking: 380, waiting: 420, excited: 300, proud: 320, sad: 500,
  oops: 260, sleepy: 900, dizzy: 160, love: 400,
  wave: 260, laugh: 140, bored: 900, yawn: 380, cool: 500, starstruck: 280, music: 420, reading: 520,
  nervous: 180, celebrate: 160, kiss: 420, sneeze: 330, shy: 800
}

export function faceGrid(mood: Mood, t: number, look: Look, blinking: boolean): Grid {
  const face = FACES[mood]
  const grid: Grid = new Map()
  const fixed = face.gaze?.(t) ?? (mood === 'thinking' ? [1, -1] : [0, 0])
  const dx = face.tracks ? (look.x > 0.35 ? 1 : look.x < -0.35 ? -1 : 0) : fixed[0]
  const dy = face.tracks ? (look.y > 0.45 ? 1 : look.y < -0.45 ? -1 : 0) : fixed[1]
  const eyes = face.eyesAt?.(t) ?? face.eyes
  const canBlink = (e: string): boolean => ['open', 'wide', 'focus'].includes(e)
  const eye = (name: string): string =>
    name === 'ringA' && t % 2 ? 'ringB' : blinking && canBlink(name) ? 'blink' : name
  stamp(grid, EYE[eye(eyes[0])]!, 3 + dx, 2 + dy)
  stamp(grid, EYE[eye(eyes[1])]!, 9 + dx, 2 + dy)
  let mouth = face.mouthAt?.(t) ?? face.mouth
  if (mouth === 'wobbleA' && t % 2) mouth = 'wobbleB'
  if (mouth === 'sleepA' && t % 2) mouth = 'sleepB'
  stamp(grid, MOUTH[mouth]!, 5 + (face.tracks ? dx : 0), 7)
  face.extra?.(grid, t)
  return grid
}

export function Sprite({ state, mood, size = 116, look, quiet = false }: {
  state: PetState; mood?: Mood; size?: number; look?: Look; quiet?: boolean
}): React.JSX.Element {
  const uid = useId().replace(/:/g, '')
  const m = mood ?? MOOD_FOR[state]
  const face = FACES[m]
  const t = useTicks(quiet ? undefined : FRAME_MS[m])
  const blinking = useBlink(!quiet)
  const grid = faceGrid(m, t, look ?? { x: 0, y: 0 }, blinking)

  // The display sits in a 120 × 100 pebble; each dot on a 6-unit pitch.
  const pitch = 5.6
  const ox = 60 - ((COLS - 1) * pitch) / 2
  const oy = 52 - ((ROWS - 1) * pitch) / 2
  const dots: React.JSX.Element[] = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = grid.get(r * COLS + c)
      dots.push(
        <circle key={r * COLS + c} cx={ox + c * pitch} cy={oy + r * pitch} r={cell ? 2.05 : 1.35}
          className={cell ? `kb-dot is-${cell}` : 'kb-dot'}
          fill={cell === 'accent' ? face.accent : cell ? '#f3f4ef' : '#ffffff'} opacity={cell ? 1 : 0.07} />
      )
    }
  }

  return (
    <svg className={`kb-sprite mood-${m} is-${state} ${quiet ? 'is-quiet' : ''}`} viewBox="0 0 120 112"
      width={size} height={(size * 112) / 120} role="img" aria-label={`Kibu is ${state}`}
      style={{ ['--kb-accent' as string]: face.accent }}>
      <defs>
        <linearGradient id={`${uid}-shell`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#2a2b2f" /><stop offset=".5" stopColor="#141518" /><stop offset="1" stopColor="#0a0a0c" />
        </linearGradient>
        <linearGradient id={`${uid}-rim`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#ffffff" stopOpacity=".38" /><stop offset=".35" stopColor="#ffffff" stopOpacity=".06" /><stop offset="1" stopColor="#ffffff" stopOpacity=".12" />
        </linearGradient>
        <radialGradient id={`${uid}-glow`}><stop stopColor={face.accent} stopOpacity=".55" /><stop offset="1" stopColor={face.accent} stopOpacity="0" /></radialGradient>
        <filter id={`${uid}-bloom`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.1" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {!quiet && <ellipse className="kb-floor" cx="60" cy="104" rx="40" ry="6" fill={`url(#${uid}-glow)`} />}
      <g className="kb-body">
        <rect className="kb-shell" x="6" y="8" width="108" height="88" rx="34" fill={`url(#${uid}-shell)`} />
        <rect x="6.5" y="8.5" width="107" height="87" rx="33.5" fill="none" stroke={`url(#${uid}-rim)`} />
        <path d="M30 13.5Q60 9 90 13.5" stroke="#fff" strokeOpacity=".22" strokeWidth="2" strokeLinecap="round" fill="none" />
        <g filter={`url(#${uid}-bloom)`}>{dots}</g>
        <circle className="kb-led" cx="98" cy="22" r="1.8" fill={face.accent} />
      </g>
    </svg>
  )
}

/** A frame counter for animated moods; static moods never re-render. */
function useTicks(ms: number | undefined): number {
  const [t, setT] = useState(0)
  useEffect(() => {
    if (!ms) return
    const id = setInterval(() => setT((n) => n + 1), ms)
    return () => clearInterval(id)
  }, [ms])
  return t
}

/** Blinks at a human rhythm: irregular, occasionally twice. */
function useBlink(enabled: boolean): boolean {
  const [shut, setShut] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      timer = setTimeout(() => {
        setShut(true)
        timer = setTimeout(() => {
          setShut(false)
          if (Math.random() < 0.2) {
            timer = setTimeout(() => { setShut(true); timer = setTimeout(() => { setShut(false); schedule() }, 110) }, 150)
          } else schedule()
        }, 120)
      }, 2200 + Math.random() * 4200)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [enabled])
  return shut
}
