import type { CSSProperties } from 'react'

export type IconName = 'expand' | 'copy' | 'list' | 'chevron' | 'spark' | 'folder' | 'search' | 'rename' | 'clock' | 'settings' | 'arrow' | 'close' | 'plus' | 'screen' | 'check' | 'help' | 'trash' | 'attach' | 'back' | 'pin' | 'minimize'
const paths: Record<IconName, string> = {
  copy: 'M9 9h10v11H9V9Zm-4 6V4h10',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  chevron: 'm15 6-6 6 6 6',
  expand: 'M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  attach: 'm8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m-5 11 7-7',
  back: 'M19 12H5m6-6-6 6 6 6',
  pin: 'M9.5 4.5h5l-.8 5 2.8 3v1h-9v-1l2.8-3-.8-5ZM12 13.5V20',
  minimize: 'M8 4.5h8M12 20V10m-4 4 4-4 4 4',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  folder: 'M3 7V5h6l2 2h10v12H3V7Z M3 10h18',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5-2L21 21',
  rename: 'm14 4 6 6M4 20l5-1L21 7l-4-4L5 15l-1 5Z',
  clock: 'M4 12a8 8 0 1 0 2.3-5.6L4 8.6M4 4v4.6h4.6M12 8v4.2l2.8 1.8',
  settings: 'M4 8h9M17 8h3M4 16h3M11 16h9M15 5.5v5M9 13.5v5',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  close: 'M7 7l10 10M17 7 7 17',
  plus: 'M12 5v14M5 12h14',
  screen: 'M3 4h18v13H3V4Zm5 17h8m-4-4v4',
  check: 'm5 12 4 4L19 6',
  help: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2-2.4 3.5M12 16.6v.1'
}
export function Icon({ name, size = 18, style }: { name: IconName; size?: number; style?: CSSProperties }): React.JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', ...style }}><path d={paths[name]} /></svg>
}
