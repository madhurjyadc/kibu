import { useId } from 'react'
import type { PetState } from '../../../shared/protocol.js'

export interface Look { x: number; y: number }
const LIGHT: Record<PetState, string> = {
  idle: '#a3fff0', listening: '#bafcff', thinking: '#c1acff', working: '#9affe0',
  waiting: '#f3d7a0', finished: '#a2ffd2', failed: '#ffaaa9'
}

/** A floating ceramic capsule. Expression and accent light follow real runtime state. */
export function Sprite({ state, size = 116, look, quiet = false }: {
  state: PetState; size?: number; look?: Look; quiet?: boolean
}): React.JSX.Element {
  const uid = useId().replace(/:/g, '')
  const light = LIGHT[state]
  const eyeHeight = state === 'thinking' ? 3.5 : state === 'failed' ? 5 : 8
  return (
    <svg className={`kb-sprite is-${state} ${quiet ? 'is-quiet' : ''}`} viewBox="0 0 120 124"
      width={size} height={size * 124 / 120} role="img" aria-label={`Kibu is ${state}`}>
      <defs>
        <linearGradient id={`${uid}-shell`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#f0f8ff" /><stop offset=".32" stopColor="#b9c7d7" />
          <stop offset=".68" stopColor="#6c7d96" /><stop offset="1" stopColor="#d9c7f7" />
        </linearGradient>
        <linearGradient id={`${uid}-visor`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#242c40" /><stop offset="1" stopColor="#0a101b" />
        </linearGradient>
        <radialGradient id={`${uid}-aura`}><stop stopColor={light} stopOpacity=".25" /><stop offset="1" stopColor={light} stopOpacity="0" /></radialGradient>
        <filter id={`${uid}-glow`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="2" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {!quiet && <>
        <ellipse className="kb-aura" cx="60" cy="65" rx="58" ry="54" fill={`url(#${uid}-aura)`} />
        <ellipse className="kb-pool" cx="60" cy="113" rx="25" ry="3" fill={light} opacity=".2" />
        <ellipse className="kb-halo" cx="60" cy="68" rx="54" ry="19" fill="none" stroke={light} strokeWidth=".7" opacity=".4" transform="rotate(-18 60 68)" />
      </>}
      <g className="kb-body-group">
        <path d="M24 64 15 68q-5 3-1 9l10 8" fill={`url(#${uid}-shell)`} stroke="#e1e9f9" strokeOpacity=".35" />
        <path d="m96 64 9 4q5 3 1 9l-10 8" fill={`url(#${uid}-shell)`} stroke="#e1e9f9" strokeOpacity=".35" />
        <rect className="kb-shell" x="21" y="30" width="78" height="66" rx="29" fill={`url(#${uid}-shell)`} stroke="#eaf5ff" strokeOpacity=".65" />
        <path d="M32 47q7-13 23-13h13" fill="none" stroke="white" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round" />
        <path d="M60 30v-8" stroke="#b9cadb" strokeWidth="2" />
        <ellipse className="kb-antenna" cx="60" cy="20" rx="5" ry="3" fill={light} filter={`url(#${uid}-glow)`} />
        <rect x="29" y="45" width="62" height="38" rx="17" fill={`url(#${uid}-visor)`} stroke="#52647e" strokeWidth="1" />
        <path d="M40 49h28" stroke="#bbcfff" strokeOpacity=".14" strokeWidth="2" strokeLinecap="round" />
        <g className="kb-face" transform={`translate(${(look?.x ?? 0) * 2.5} ${(look?.y ?? 0) * 2})`} fill={light}>
          {state === 'finished' ? <g fill="none" stroke={light} strokeWidth="3" strokeLinecap="round" filter={`url(#${uid}-glow)`}><path d="M40 63q5-7 10 0M70 63q5-7 10 0" /></g> : <g filter={`url(#${uid}-glow)`}>
            <rect className="kb-eye" x="42" y={62-eyeHeight/2} width="6" height={eyeHeight} rx="3" />
            <rect className="kb-eye" x="72" y={62-eyeHeight/2} width="6" height={eyeHeight} rx="3" />
          </g>}
          <path d={state === 'failed' ? 'M56 73q4-4 8 0' : 'M56 70q4 4 8 0'} fill="none" stroke={light} strokeWidth="1.5" strokeLinecap="round" />
          <ellipse cx="38" cy="70" rx="3" ry="1" opacity=".3" /><ellipse cx="82" cy="70" rx="3" ry="1" opacity=".3" />
        </g>
        <rect x="53" y="88" width="14" height="2" rx="1" fill={light} opacity=".8" />
      </g>
    </svg>
  )
}
