import type { PetState } from '../../../shared/protocol.js'

/**
 * Placeholder artwork, driven by real runtime state.
 *
 * Every visual difference here corresponds to an actual state the task
 * runtime reports — nothing loops decoratively while the assistant is idle,
 * and 'working' cannot appear unless a tool is genuinely executing.
 */
const EYES: Record<PetState, { rx: number; ry: number; dy: number }> = {
  idle: { rx: 5, ry: 5, dy: 0 },
  listening: { rx: 6, ry: 6.5, dy: -1 },
  thinking: { rx: 5, ry: 3, dy: -2 },
  working: { rx: 4.5, ry: 5, dy: 0 },
  waiting: { rx: 6, ry: 6, dy: 0 },
  finished: { rx: 5.5, ry: 2, dy: -1 },
  failed: { rx: 4, ry: 4, dy: 2 }
}

const TINT: Record<PetState, string> = {
  idle: '#8ab4ff',
  listening: '#7ee0c8',
  thinking: '#b79bff',
  working: '#ffc46b',
  waiting: '#ffd966',
  finished: '#6ddf8e',
  failed: '#ff8a8a'
}

export function Sprite({ state }: { state: PetState }): React.JSX.Element {
  const eyes = EYES[state]
  const tint = TINT[state]

  return (
    <svg className={`sprite state-${state}`} viewBox="0 0 120 130" width="120" height="130" role="img" aria-label={`Kibu is ${state}`}>
      <defs>
        <radialGradient id="body" cx="42%" cy="34%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="55%" stopColor={tint} stopOpacity="0.95" />
          <stop offset="100%" stopColor={tint} stopOpacity="0.72" />
        </radialGradient>
        <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <ellipse className="shadow" cx="60" cy="118" rx="28" ry="6" fill="rgba(0,0,0,.22)" />

      <g className="body-group">
        <path
          className="body"
          d="M60 16c24 0 40 19 40 44 0 26-17 44-40 44S20 86 20 60c0-25 16-44 40-44z"
          fill="url(#body)"
          filter="url(#soft)"
        />
        <ellipse className="eye left" cx="46" cy={58 + eyes.dy} rx={eyes.rx} ry={eyes.ry} fill="#20222c" />
        <ellipse className="eye right" cx="74" cy={58 + eyes.dy} rx={eyes.rx} ry={eyes.ry} fill="#20222c" />
        {state === 'finished' ? (
          <path className="mouth" d="M50 76q10 9 20 0" stroke="#20222c" strokeWidth="3" fill="none" strokeLinecap="round" />
        ) : state === 'failed' ? (
          <path className="mouth" d="M50 80q10 -8 20 0" stroke="#20222c" strokeWidth="3" fill="none" strokeLinecap="round" />
        ) : (
          <path className="mouth" d="M53 76q7 5 14 0" stroke="#20222c" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        )}
      </g>

      {state === 'thinking' && (
        <g className="think-dots">
          <circle cx="96" cy="30" r="3" />
          <circle cx="104" cy="22" r="2.2" />
          <circle cx="110" cy="16" r="1.6" />
        </g>
      )}
      {state === 'working' && (
        <g className="work-ring">
          <circle cx="60" cy="60" r="50" fill="none" stroke={tint} strokeWidth="2.5" strokeDasharray="14 10" opacity="0.7" />
        </g>
      )}
      {state === 'waiting' && <circle className="waiting-pulse" cx="60" cy="60" r="52" fill="none" stroke={tint} strokeWidth="2" />}
    </svg>
  )
}
