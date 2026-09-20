/** Renderer-side path helpers. The renderer has no Node, so these are manual. */
export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function dirname(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

export function shortenPath(p: string, home?: string): string {
  const withHome = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p
  const parts = withHome.split('/')
  if (parts.length <= 4) return withHome
  return `${parts.slice(0, 2).join('/')}/…/${parts.slice(-2).join('/')}`
}
