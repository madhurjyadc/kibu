import type { CSSProperties } from 'react'

export type IconName = 'spark' | 'folder' | 'search' | 'rename' | 'clock' | 'settings' | 'arrow' | 'close' | 'plus' | 'screen' | 'check' | 'help' | 'trash' | 'attach' | 'back'
const paths: Record<IconName, string> = {
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  attach: 'm8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m-5 11 7-7',
  back: 'M19 12H5m6-6-6 6 6 6',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  folder: 'M3 7V5h6l2 2h10v12H3V7Z M3 10h18',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5-2L21 21',
  rename: 'm14 4 6 6M4 20l5-1L21 7l-4-4L5 15l-1 5Z',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  settings: 'M5 4v16M12 4v16M19 4v16M2 8h6M9 16h6M16 9h6',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  close: 'm6 6 12 12M6 18 18 6',
  plus: 'M12 5v14M5 12h14',
  screen: 'M3 4h18v13H3V4Zm5 17h8m-4-4v4',
  check: 'm5 12 4 4L19 6',
  help: 'M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'
}
export function Icon({ name, size = 18, style }: { name: IconName; size?: number; style?: CSSProperties }): React.JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>
}
