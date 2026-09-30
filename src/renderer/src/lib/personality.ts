import type { Mood } from '../components/Sprite.js'

/**
 * What Kibu says when nobody asked.
 *
 * Two rules keep this charming rather than annoying or dishonest:
 * - Anything about a task is built from the task's real state. It never
 *   claims progress it cannot see: "3 of 5 done" only when the plan says so,
 *   otherwise it talks about waiting, not about being nearly finished.
 * - An offer only ever puts words in the composer. Nothing runs until the
 *   person presses Enter.
 */
export interface Line {
  text: string
  mood: Mood
  /** A single button on the bubble. `compose` types a request; `open` just opens the panel. */
  action?: { label: string; compose?: string; open?: boolean }
}

const pick = <T,>(xs: readonly T[], seed = Math.random()): T => xs[Math.floor(seed * xs.length) % xs.length]!

export function hello(hour: number): Line {
  if (hour >= 5 && hour < 12) return { text: 'Morning! I’m here when you need me.', mood: 'wave' }
  if (hour >= 12 && hour < 17) return { text: 'Hey there. I’m around if you need anything.', mood: 'wave' }
  if (hour >= 17 && hour < 22) return { text: 'Evening! Need a hand with anything?', mood: 'wave' }
  return { text: 'Burning the midnight oil? I’m here.', mood: 'wave' }
}

/** The first thing it says when handed a job: a little acknowledgement, tuned to the kind of job. */
export function onStart(request: string): Line {
  const r = request.toLowerCase()
  if (/\b(find|where|search|locate|look for)\b/.test(r)) return { text: pick(['Let’s find it.', 'On the hunt.', 'Looking…']), mood: 'determined' }
  if (/\b(organi[sz]e|tidy|clean|sort)\b/.test(r)) return { text: pick(['Ooh, tidying. My favourite.', 'Let’s make it neat.']), mood: 'determined' }
  if (/\b(rename)\b/.test(r)) return { text: 'Giving them proper names.', mood: 'determined' }
  if (/\?\s*$/.test(r)) return { text: 'Good question. One sec.', mood: 'thinking' }
  return { text: pick(['On it.', 'Got it. On it.', 'Leave it with me.']), mood: 'determined' }
}

/** A kind word during a long job, grounded in what the task actually knows. */
export function checkIn(input: { seconds: number; done: number; total: number; turn: number }): Line {
  if (input.total > 1 && input.done > 0) {
    return { text: `${input.done} of ${input.total} steps done. Still going.`, mood: 'working' }
  }
  const lines: Line[] = [
    { text: 'Still at it. Thanks for waiting.', mood: 'shy' },
    { text: 'This one’s taking a bit. I haven’t forgotten you.', mood: 'nervous' },
    { text: 'Still working. Carry on with your thing.', mood: 'determined' },
    { text: 'Reading through it carefully.', mood: 'reading' }
  ]
  return lines[input.turn % lines.length]!
}

/** When it has been waiting on an answer for a while. */
export function nudge(): Line {
  return { text: pick(['No rush. I’ll be right here.', 'Whenever you’re ready.']), mood: 'shy', action: { label: 'Answer', open: true } }
}

/** How a finished job feels: big jobs get a party, quick ones get sunglasses. */
export function successMood(actions: number, seconds: number): Mood {
  if (actions >= 8) return 'celebrate'
  if (actions > 0 && seconds < 4) return 'cool'
  if (actions >= 3) return 'starstruck'
  return 'proud'
}

export function afterSuccess(): Line | null {
  if (Math.random() > 0.45) return null
  return pick([
    { text: 'Anything else I can do?', mood: 'happy', action: { label: 'Yes', open: true } },
    { text: 'That felt good.', mood: 'music' }
  ] satisfies Line[])
}

export function afterFailure(): Line {
  return { text: 'Sorry about that. Want to see what went wrong?', mood: 'nervous', action: { label: 'Show me', open: true } }
}

export const reactions = {
  tickled: (): Line => ({ text: pick(['Hey, that tickles!', 'Hehe, stop it.', 'You had to be there.']), mood: 'laugh' }),
  loved: (): Line => ({ text: pick(['Aw.', 'You’re sweet.', 'Oh. That’s nice.']), mood: 'kiss' }),
  /** Rubbing the cursor back and forth over it: being petted. */
  petted: (): Line => ({ text: pick(['Oh. That’s nice.', 'You get me.', 'My favourite human.']), mood: 'love' }),
  picked: (): Line => ({ text: pick(['Wheee.', 'Whoa, where are we going?']), mood: 'surprised' }),
  landed: (shaken: boolean): Line =>
    shaken ? { text: pick(['Nice landing. Mostly.', 'The room is spinning.']), mood: 'dizzy' } : { text: pick(['Nice spot.', 'Ooh, new view.']), mood: 'happy' },
  carried: (): Line => ({ text: pick(['Whoa. Warn me next time.', 'I’m getting dizzy…']), mood: 'pout' }),
  woke: (): Line => ({ text: pick(['Oh! Hi.', 'I’m up, I’m up.']), mood: 'wave' }),
  yawn: (): Line => ({ text: 'Getting a little sleepy…', mood: 'yawn' }),
  undone: (n: number): Line => ({ text: n ? `My bad. Put ${n} back.` : 'Nothing to put back.', mood: 'oops' }),
  hovered: (): Line => ({ text: pick(['Hi.', 'Oh, hello.']), mood: 'shy' }),
  fed: (n: number): Line => ({ text: n === 1 ? 'Ooh, what’s this?' : `Ooh, ${n} things. What are we doing?`, mood: 'excited' }),
  /** Just after a drop: crunch. */
  ate: (n: number): Line => (n >= 3 ? { text: 'Delicious. Five stars.', mood: 'celebrate' } : { text: pick(['Nom. Zero crumbs.', 'A little byte.']), mood: 'happy' }),
  danceStart: (): Line => ({ text: 'Tiny desk disco.', mood: 'music' }),
  danceEnd: (): Line => ({ text: 'Still got it.', mood: 'cool' }),
  nap: (): Line => ({ text: 'Recharging. Zzz.', mood: 'sleepy' }),
  napWake: (): Line => ({ text: 'Five more minutes?', mood: 'yawn' })
}

/** "Surprise me": the website's party tricks, in turn. */
export const SURPRISES: readonly Line[] = [
  { text: 'Too cool for busywork.', mood: 'cool' },
  { text: 'Ah… ah… achoo.', mood: 'sneeze' },
  { text: 'You’re kind of a big deal.', mood: 'starstruck' },
  { text: 'A little thank-you.', mood: 'kiss' },
  { text: 'You had to be there.', mood: 'laugh' },
  { text: 'Hi again, favourite human.', mood: 'wave' },
  { text: 'Between you and me…', mood: 'wink' }
]

/**
 * The occasional unprompted remark while idle. It depends on the hour and on
 * how long the person has been at their desk; offers only ever fill in the
 * composer.
 */
export function idleRemark(hour: number, activeMinutes: number, turn: number): Line {
  if (activeMinutes >= 90 && turn % 3 === 0) return { text: 'You’ve been at it a while. Stretch?', mood: 'shy' }
  const timely: Line[] = []
  if (hour >= 5 && hour < 11) timely.push({ text: 'What’s first today?', mood: 'curious', action: { label: 'Tell me', open: true } })
  if (hour >= 12 && hour < 14) timely.push({ text: 'Lunch soon? I’ll keep watch.', mood: 'music' })
  if (hour >= 23 || hour < 4) timely.push({ text: 'It’s late. Don’t stay up too long.', mood: 'shy' })
  const general: Line[] = [
    { text: 'Want me to tidy your Downloads?', mood: 'curious', action: { label: 'Sure', compose: 'Organize my Downloads folder' } },
    { text: 'Looking for something? I’m good at finding things.', mood: 'determined', action: { label: 'Find', compose: 'Find ' } },
    { text: 'Just humming to myself.', mood: 'music' },
    { text: 'Achoo! Sorry. Dusty in here.', mood: 'sneeze' },
    { text: 'Got anything for me? I’m a bit bored.', mood: 'bored', action: { label: 'Sure', open: true } },
    { text: 'I like keeping you company.', mood: 'shy' }
  ]
  const pool = [...timely, ...general]
  return pool[turn % pool.length]!
}
