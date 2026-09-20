import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Jev, choice, score } from './model/jev.js'
import type { BenchRow, ModelConfig } from '../shared/protocol.js'
import { evaluateArithmetic } from './loop/calculate.js'

/**
 * Times every route a request can actually take on this machine.
 *
 * The point is to stop guessing where the seconds go. Jev's own latency, the
 * macOS index, and pure local work differ by two orders of magnitude, and
 * which one a feature can afford is a measurement, not an opinion. It runs in
 * the runtime because that is where the key already is — no credential has to
 * be copied anywhere to find out how fast it is.
 */
export async function runBench(jevApiKey: string | null, model: ModelConfig): Promise<BenchRow[]> {
  const rows: BenchRow[] = []

  async function time(
    group: string,
    label: string,
    fn: () => Promise<string>,
    usd?: () => number
  ): Promise<void> {
    const started = performance.now()
    let detail: string
    try {
      detail = await fn()
    } catch (err) {
      detail = `failed: ${err instanceof Error ? err.message : String(err)}`
    }
    rows.push({ group, label, ms: Math.round(performance.now() - started), detail, ...(usd ? { usd: usd() } : {}) })
  }

  /* ---- Jev, over the real network ---- */
  const jev = new Jev(jevApiKey, true, model.jev)
  if (!jev.available) {
    rows.push({ group: 'Jev', label: 'not configured', ms: 0, detail: 'no TypeSafe key, so nothing to measure' })
  } else {
    let spent = 0
    const spentSince = (): number => {
      const now = jev.metrics.totalUsd
      const delta = now - spent
      spent = now
      return delta
    }

    await time(
      'Jev',
      'first call (includes TLS handshake)',
      async () => {
        const a = await jev.ask(
          'bench_warm',
          { userRequest: 'find my tax pdf' },
          { kind: choice('What is this?', { file: 'A file search.', app: 'Launching an app.', other: 'Something else.' }) }
        )
        return a ? `answered "${a.kind.choice}"` : 'no answer (check the key)'
      },
      spentSince
    )

    // Deliberately ask Jev directly rather than through routeRequest: that
    // method answers from local keyword rules whenever it can, so timing it
    // measures the shortcut, not the model. A previous version of this bench
    // did exactly that and reported sub-millisecond "Jev" calls.
    for (let i = 1; i <= 3; i++) {
      await time(
        'Jev',
        `one small question (warm, run ${i})`,
        async () => {
          const a = await jev.ask(
            'bench_small',
            { userRequest: 'the thing I was working on this afternoon' },
            {
              kind: choice('What kind of work is this?', {
                files: 'Something about files on disk.',
                apps: 'Something about applications on this Mac.',
                web: 'Something on a website.'
              })
            }
          )
          return a ? `chose "${a.kind.choice}"` : 'no answer'
        },
        spentSince
      )
    }

    await time(
      'Jev',
      'route a request (local rules may answer)',
      async () => {
        const r = await jev.routeRequest('find the ethernet frames pdf I downloaded last week', false)
        return `chose "${r.route}" — ${r.reason}`
      },
      spentSince
    )

    // The ranking call a natural-language search would actually make.
    const candidates = (await mdfind(['-onlyin', join(homedir(), 'Downloads'), 'kind:pdf']))
      .slice(0, 40)
      .map((p) => p.split('/').pop() ?? p)
    if (candidates.length > 0) {
      // A rubric, not a bare number: Jev scores against described levels.
      const RUBRIC = [
        'Nothing about this file matches the request.',
        'Only loosely related.',
        'Plausibly the file, but not clearly.',
        'Very likely the file the user means.',
        'Certainly the file the user means.'
      ] as const
      const questions: Record<string, ReturnType<typeof score>> = {}
      candidates.forEach((name, i) => {
        questions[`c${i}`] = score(`How well does "${name}" match what the user asked for?`, RUBRIC)
      })
      await time(
        'Jev',
        `rank ${candidates.length} real candidates, one call`,
        async () => {
          const a = await jev.ask(
            'bench_rank',
            { userRequest: 'the pdf about ethernet frames from last week', candidates },
            questions
          )
          if (!a) return 'no answer'
          const top = candidates
            .map((n, i) => ({ n, s: (a[`c${i}`] as { score?: number } | undefined)?.score ?? 0 }))
            .sort((x, y) => y.s - x.s)
            .slice(0, 2)
          return `best: ${top.map((t) => `${t.n} (${t.s})`).join(', ')}`
        },
        spentSince
      )
    }
  }

  /* ---- The index macOS already maintains ---- */
  const home = homedir()
  await time('macOS index', 'whole home, by content', async () => `${(await mdfind(['-onlyin', home, 'ethernet'])).length} hits`)
  await time('macOS index', 'Downloads, kind:pdf', async () => `${(await mdfind(['-onlyin', join(home, 'Downloads'), 'kind:pdf'])).length} hits`)
  await time(
    'macOS index',
    'Downloads, modified this week',
    async () => `${(await mdfind(['-onlyin', join(home, 'Downloads'), 'kMDItemContentModificationDate >= $time.today(-7)'])).length} hits`
  )
  await time(
    'macOS index',
    'every installed application',
    async () => `${(await mdfind(['kMDItemContentType == "com.apple.application-bundle"'])).length} apps`
  )

  /* ---- No model at all ---- */
  await time('local', 'arithmetic, parsed and evaluated', async () => {
    const value = evaluateArithmetic('18% of 4250 + 12*3')
    return value === null ? 'could not parse' : `= ${value}`
  })
  await time('local', 'match an app name by prefix', async () => {
    const apps = await mdfind(['kMDItemContentType == "com.apple.application-bundle"'])
    const hit = apps.find((p) => (p.split('/').pop() ?? '').toLowerCase().startsWith('saf'))
    return hit ? `"saf" → ${hit.split('/').pop()}` : 'no match'
  })

  return rows
}

function mdfind(args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/mdfind', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.split('\n').filter(Boolean))
    })
  })
}


