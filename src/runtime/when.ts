/**
 * Reads times out of everyday phrasing — "tomorrow at 5", "next friday 3pm",
 * "in 20 minutes", "tonight" — with no model involved.
 *
 * The one genuinely ambiguous case, an hour with no am/pm ("at 5"), is not
 * guessed here: both readings come back as candidates, so a caller can let
 * Jev pick between them using the rest of the sentence, and fall back to the
 * plain default (the next one to come round) when Jev is unavailable.
 */

export interface TimeReading {
  /** Candidate moments, most likely first. Always at least one. */
  candidates: Date[]
  /** True when only a day was named ("on friday"), with no time of day. */
  dateOnly: boolean
  /** The phrase that was read, so it can be removed from a title. */
  matched: string[]
  /** An explicit duration ("for 30 minutes"), in minutes. */
  durationMin?: number
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const PARTS: Record<string, number> = { morning: 9, noon: 12, midday: 12, afternoon: 15, evening: 18, tonight: 20, night: 20, midnight: 0 }
const UNIT_MIN: Record<string, number> = { min: 1, minute: 1, minutes: 1, mins: 1, hour: 60, hours: 60, hr: 60, hrs: 60, h: 60, day: 1440, days: 1440, week: 10080, weeks: 10080 }

function atDay(base: Date, offsetDays: number): Date {
  const d = new Date(base)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offsetDays)
  return d
}

function withTime(day: Date, h: number, m: number): Date {
  const d = new Date(day)
  d.setHours(h, m, 0, 0)
  return d
}

export function readTime(text: string, now = new Date()): TimeReading | null {
  const t = ` ${text.toLowerCase().replace(/[,]/g, ' ')} `
  const matched: string[] = []
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(t)
    if (m) matched.push(m[0].trim())
    return m
  }

  let durationMin: number | undefined
  const dur = take(/\bfor (?:an? |(\d+(?:\.\d+)?) ?)(min(?:ute)?s?|hours?|hrs?|h)\b/)
  if (dur) durationMin = (dur[1] ? Number(dur[1]) : 1) * (UNIT_MIN[dur[2]!] ?? 60)

  // "in 20 minutes", "in an hour", "in 2 days"
  const rel = take(/\bin (?:an? |(\d+(?:\.\d+)?) ?)(min(?:ute)?s?|hours?|hrs?|h|days?|weeks?)\b/)
  if (rel) {
    const mins = (rel[1] ? Number(rel[1]) : 1) * (UNIT_MIN[rel[2]!] ?? 1)
    return { candidates: [new Date(now.getTime() + mins * 60_000)], dateOnly: false, matched, durationMin }
  }

  // Which day.
  let day: Date | null = null
  let dayNamed = false
  /** "friday" said on a Friday: today if the time is still ahead, else next week. */
  let weekdayIsToday = false
  if (take(/\bday after tomorrow\b/)) { day = atDay(now, 2); dayNamed = true }
  else if (take(/\b(?:tomorrow|tmrw|tmr)\b/)) { day = atDay(now, 1); dayNamed = true }
  else if (take(/\btoday\b/)) { day = atDay(now, 0); dayNamed = true }
  if (!day) {
    const wd = take(new RegExp(`\\b(?:(next|this|on|coming) )?(${WEEKDAYS.join('|')})\\b`))
    if (wd) {
      const target = WEEKDAYS.indexOf(wd[2]!)
      let diff = (target - now.getDay() + 7) % 7
      // "next friday" is read as the coming friday, which is what people usually mean.
      if (diff === 0) {
        if (wd[1] === 'next') diff = 7
        else weekdayIsToday = true
      }
      day = atDay(now, diff)
      dayNamed = true
    }
  }
  if (!day) {
    // "sep 30", "30 sep", "september 30th"
    const md = take(new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)? (${MONTHS.join('|')})[a-z]*|(${MONTHS.join('|')})[a-z]* (\\d{1,2})(?:st|nd|rd|th)?)\\b`))
    if (md) {
      const month = MONTHS.indexOf((md[2] ?? md[3])!)
      const date = Number(md[1] ?? md[4])
      const d = new Date(now.getFullYear(), month, date)
      if (d.getTime() < atDay(now, 0).getTime()) d.setFullYear(d.getFullYear() + 1)
      day = d
      dayNamed = true
    }
  }

  // Which time.
  let hours: number[] | null = null
  let minutes = 0
  const clock = take(/\b(?:at |@ ?|by )?(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)?(?= |$)/)
  // A bare number only counts as a time when "at"/"by" introduced it or it
  // has minutes or am/pm; "call 3 people" is not about 3 o'clock.
  const clockCounts = clock && (/^(at|@|by)/.test(clock[0]) || clock[2] || clock[3])
  if (clock && !clockCounts) matched.pop()
  if (clock && clockCounts) {
    let h = Number(clock[1])
    minutes = clock[2] ? Number(clock[2]) : 0
    const mer = clock[3]?.replace(/\./g, '')
    if (h > 23 || minutes > 59) return null
    if (mer === 'pm' && h < 12) h += 12
    if (mer === 'am' && h === 12) h = 0
    if (mer || h > 12 || h === 0) hours = [h]
    else if (/\b(morning|am)\b/.test(t)) hours = [h === 12 ? 0 : h]
    else if (/\b(afternoon|evening|tonight|night|pm)\b/.test(t)) hours = [h === 12 ? 12 : h + 12]
    // "at 5" with nothing else: both readings, the one people usually mean first.
    // 8–11 lean morning; 1–7 lean afternoon or evening ("call mom at 7").
    else hours = h >= 8 && h <= 11 ? [h, h + 12] : h === 12 ? [12, 0] : [h + 12, h]
  } else {
    const part = take(/\b(?:this |tomorrow )?(morning|noon|midday|afternoon|evening|tonight|night|midnight)\b/)
    if (part) {
      hours = [PARTS[part[1]!]!]
      if (part[1] === 'tonight' && !day) { day = atDay(now, 0); dayNamed = true }
    }
  }

  if (!dayNamed && !hours) return null

  const candidates: Date[] = []
  if (hours) {
    for (const h of hours) {
      let d = withTime(day ?? atDay(now, 0), h, minutes)
      // No day named and that time has passed today: the next one.
      if (!dayNamed && d.getTime() <= now.getTime()) d = withTime(atDay(now, 1), h, minutes)
      if (weekdayIsToday && d.getTime() <= now.getTime()) d = withTime(atDay(now, 7), h, minutes)
      candidates.push(d)
    }
    // Without a named day, the soonest reading is the likeliest.
    if (!dayNamed) candidates.sort((a, b) => a.getTime() - b.getTime())
  } else {
    candidates.push(day!)
  }
  return { candidates, dateOnly: !hours, matched, durationMin }
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, 'twenty-five': 25, thirty: 30, forty: 40, 'forty-five': 45,
  fifty: 50, sixty: 60, ninety: 90
}
const SPELLED = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})(?=[ -](?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\\b)`, 'gi')

/**
 * Spelled-out durations as digits: "one minute" → "1 minute", "an hour" →
 * "1 hour", "half an hour" → "30 minutes". Only a number directly in front
 * of a unit is touched, so "someone" and "a timer" stay as they are.
 */
export function spelledDurations(text: string): string {
  return text.replace(/\bhalf an? hour\b/gi, '30 minutes').replace(SPELLED, (w) => String(NUMBER_WORDS[w.toLowerCase()]))
}

/** Removes the time phrases (and the glue words around them) from a title. */
export function stripTime(text: string, reading: TimeReading | null): string {
  let out = ` ${text} `
  for (const phrase of reading?.matched ?? []) {
    out = out.replace(new RegExp(`\\s${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,.!?])`, 'i'), ' ')
  }
  return out
    .replace(/\s+(?:on|at|by|for|in)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;!-]+$/g, '')
}

/** "Tue 30 Sep, 5:00 pm" — how a time is shown back to the person. */
export function describeTime(d: Date, dateOnly = false, now = new Date()): string {
  const today = atDay(now, 0).getTime()
  const day = atDay(d, 0).getTime()
  const dayLabel =
    day === today ? 'today' : day === today + 86_400_000 ? 'tomorrow'
      : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  if (dateOnly) return dayLabel
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  return `${dayLabel} at ${time}`
}
