import type { BenchRow } from '../../../shared/protocol.js'

/**
 * What each route actually costs on this machine, measured rather than
 * assumed. Grouped by where the work happens, because that is the decision:
 * anything on the network is a different design from anything local.
 */
export function Bench({ rows, running }: { rows: BenchRow[]; running: boolean }): React.JSX.Element {
  if (running && rows.length === 0) {
    return <p className="pane-empty">Timing every route — the network calls take a few seconds…</p>
  }
  const groups = [...new Set(rows.map((r) => r.group))]
  const spent = rows.reduce((sum, r) => sum + (r.usd ?? 0), 0)

  return (
    <div className="pane bench">
      {groups.map((g) => (
        <section key={g}>
          <p className="pane-title">{g}</p>
          <ul>
            {rows
              .filter((r) => r.group === g)
              .map((r, i) => (
                <li key={`${g}-${i}`}>
                  <span className={`bench-ms ${band(r.ms)}`}>{format(r.ms)}</span>
                  <span className="bench-label">{r.label}</span>
                  <span className="bench-detail dim">{r.detail}</span>
                </li>
              ))}
          </ul>
        </section>
      ))}
      <p className="trace">
        <span>
          {spent > 0 ? `this measurement cost $${spent.toFixed(6)}` : 'nothing was charged for this measurement'}
        </span>
      </p>
    </div>
  )
}

function format(ms: number): string {
  if (ms < 1) return '<1ms'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** Under 100ms feels instant, under a second feels responsive, past that you wait. */
function band(ms: number): string {
  if (ms < 100) return 'fast'
  if (ms < 1000) return 'ok'
  return 'slow'
}
