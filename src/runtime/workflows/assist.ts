import { choice } from '../model/jev.js'
import { describeTime, readTime, stripTime, type TimeReading } from '../when.js'
import type { CalendarEvent, ScreenContext } from '../tools/mac.js'
import type { Evidence, Memory } from '../../shared/types.js'
import { learnedChoice, suggestChoice } from '../memory.js'
import { aboutWords } from './memory.js'
import type { Workflow, WorkflowContext, WorkflowResult } from './types.js'

/**
 * Everyday requests to Mac apps, handled by code and Jev with no planning
 * model: "remind me to call the bank tomorrow at 5", "put dentist on my
 * calendar friday 10am", "what's on tomorrow", "dark mode", "run my Focus
 * shortcut", "make a note: …".
 *
 * The workflow rule holds here too. Titles and times are read out of the
 * user's own words by local code; Jev only chooses between things that code
 * built — which of two readings of "at 5", which of the user's real
 * calendars, which of their real shortcuts. When a request needs anything
 * invented, the workflow hands it to the planner.
 */

const APPS_ROUTES = ['apps', 'desktop', 'files', 'mixed', 'unclear']

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Of two or more readings of a time, lets Jev pick; the first is the default. */
async function pickTime(ctx: WorkflowContext, request: string, reading: TimeReading): Promise<Date> {
  if (reading.candidates.length === 1) return reading.candidates[0]!
  const options: Record<string, string> = {}
  reading.candidates.forEach((d, i) => { options[`t${i}`] = d.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' }) })
  const answers = await ctx.ask('pick_time', { userRequest: request, now: new Date().toLocaleString('en-US') }, {
    when: choice('Which time does the user mean?', options)
  })
  const pick = (answers?.when as { choice?: string } | undefined)?.choice
  const index = pick ? Number(pick.slice(1)) : 0
  return reading.candidates[index] ?? reading.candidates[0]!
}

/**
 * One of the user's real names (calendars, lists, shortcuts): the one the
 * request names, else Jev's pick among them, else `fallback`.
 */
async function pickNamed(
  ctx: WorkflowContext,
  label: string,
  request: string,
  names: string[],
  question: string,
  fallback: string | null
): Promise<string | null> {
  if (names.length === 0) return fallback
  if (names.length === 1) return names[0]!
  const named = names
    .filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(request))
    .sort((a, b) => b.length - a.length)[0]
  if (named) return named
  const options: Record<string, string> = {}
  names.slice(0, 60).forEach((n, i) => { options[`n${i}`] = n })
  const answers = await ctx.ask(label, { userRequest: request }, { pick: choice(question, options) })
  const pick = (answers?.pick as { choice?: string } | undefined)?.choice
  return pick ? (names[Number(pick.slice(1))] ?? fallback) : fallback
}

async function runOrFail<T>(ctx: WorkflowContext, tool: string, input: unknown): Promise<T> {
  const res = await ctx.run(tool, input)
  if (!res.ok) throw new Error(res.error ?? `${tool} failed`)
  return res.result as T
}

function failed(err: unknown): WorkflowResult {
  return { success: false, headline: err instanceof Error ? err.message : String(err), evidence: [] }
}

/* ------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------ */

const REMIND = /\b(?:remind me|set a reminder|add a reminder|remember to|add .+ to (?:my |the )?(?:[\w-]+ )?(?:reminders|to-?do(?: list)?|todo list))\b/i

export function reminderTitle(request: string, reading: TimeReading | null): string {
  let r = stripTime(request, reading)
  r = r.replace(/^\s*(?:hey |please |kibu[, ]+)*/i, '')
  const add = /^add (.+?) to (?:my |the )?(?:[\w-]+ )?(?:reminders|to-?do(?: list)?|todo list)\b(.*)$/i.exec(r)
  if (add) r = `${add[1]} ${add[2]}`
  r = r
    .replace(/^(?:can you |could you )?(?:remind me|set a reminder|add a reminder|remember)\s*(?:to|about|that|:)?\s*/i, '')
    .replace(/\s*\b(?:please|thanks?|thank you)\b\s*$/i, '')
  return capitalize(r.replace(/\s{2,}/g, ' ').trim())
}

export const reminderWorkflow: Workflow = {
  id: 'add_reminder',
  description: 'Add a reminder to the Reminders app, possibly at a time.',
  routes: APPS_ROUTES,
  plausible: (request) => REMIND.test(request),
  async run(request, _dropped, ctx) {
    const reading = readTime(request)
    const title = reminderTitle(request, reading)
    if (!title) return { success: false, headline: 'What should I remind you about?', evidence: [], handoffToPlanner: 'no reminder text' }
    try {
      const due = reading ? await pickTime(ctx, request, reading) : null
      const lists = await runOrFail<string[]>(ctx, 'reminders_lists', {})
      // Only a list the user actually named; otherwise the default list.
      // "Reminders" is also just the word for them, so a specific name wins over it.
      const generic = (n: string): boolean => /^(reminders|to-?do|todo)$/i.test(n)
      const named = lists
        .filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(request))
        .sort((a, b) => Number(generic(a)) - Number(generic(b)) || b.length - a.length)[0]
      // Not named this time: the list this kind of reminder went on before, if any.
      const remembered = named ? null : suggestChoice('reminder-list', title, ctx.memory.all(), lists)
      const list = named ?? remembered?.choice?.value
      const made = await runOrFail<{ list: string }>(ctx, 'reminders_create', {
        title,
        ...(due ? { due: due.toISOString() } : {}),
        ...(list ? { list } : {})
      })
      const when = due ? ` ${describeTime(due, reading?.dateOnly)}` : ''
      const evidence: Evidence[] = [{ kind: 'text', label: `Reminders · ${made.list}`, value: `${title}${when ? ` —${when}` : ''}` }]
      if (remembered) evidence.push(ctx.memory.used(remembered))
      // Naming a specific list is a choice worth keeping for next time.
      if (named && !generic(named) && ctx.memory.learn) {
        const m = learnedChoice('reminder-list', named, title, `Reminders like "${title}" go on the ${named} list`)
        if (m) ctx.memory.keep(m)
      }
      return {
        success: true,
        headline: `I'll remind you: ${title}${when}${remembered ? ` (on ${made.list}, like last time)` : ''}.`,
        evidence
      }
    } catch (err) {
      return failed(err)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Calendar: add an event
 * ------------------------------------------------------------------ */

const ADD_EVENT =
  /\b(?:(?:add|put|schedule|book|block(?: out)?|create|set up)\b.*\b(?:calendar|meeting|event|appointment|call|lunch|dinner|coffee|sync|1:1|interview)|\bon my calendar\b)/i

export function eventTitle(request: string, reading: TimeReading | null): string {
  let r = stripTime(request, reading)
  r = r
    .replace(/^\s*(?:hey |please |kibu[, ]+)*(?:can you |could you )?/i, '')
    .replace(/^(?:add|put|schedule|book|block(?: out)?|create|set up)\s+(?:an? |the )?(?:new )?(?:event |meeting |time )?(?:for |called |named )?/i, '')
    .replace(/\s*\b(?:to|on|in|into) (?:my |the )?(?:[\w-]+ )?calendar\b.*$/i, '')
    .replace(/\s*\bon my calendar\b/i, '')
    .replace(/\s*\b(?:please|thanks?)\b\s*$/i, '')
  return capitalize(r.replace(/\s{2,}/g, ' ').trim())
}

export const eventWorkflow: Workflow = {
  id: 'add_event',
  description: 'Add an event or meeting to the Calendar app at a given time.',
  routes: APPS_ROUTES,
  plausible: (request) => ADD_EVENT.test(request) && !REMIND.test(request) && !/\b(what|when|am i|do i have)\b/i.test(request),
  async run(request, _dropped, ctx) {
    const reading = readTime(request)
    if (!reading) return { success: false, headline: 'When should it be?', evidence: [], handoffToPlanner: 'no time given for the event' }
    const title = eventTitle(request, reading)
    if (!title) return { success: false, headline: 'What is the event?', evidence: [], handoffToPlanner: 'no event title' }
    try {
      const start = await pickTime(ctx, request, reading)
      const minutes = reading.durationMin ?? 60
      const end = reading.dateOnly ? new Date(start.getTime() + 86_400_000) : new Date(start.getTime() + minutes * 60_000)

      const calendars = (await runOrFail<{ name: string; writable: boolean }[]>(ctx, 'calendar_list_calendars', {}))
        // Calendars macOS keeps for itself are never where a new event belongs.
        .filter((c) => c.writable && !/^(scheduled reminders|siri suggestions|birthdays|found in (mail|apps))$/i.test(c.name))
        .map((c) => c.name)
      const named = calendars
        .filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(request))
        .sort((a, b) => b.length - a.length)[0]
      // Not named this time: where this kind of event went before, else Jev's pick.
      const remembered: Memory | null = named ? null : suggestChoice('calendar', title, ctx.memory.all(), calendars)
      const calendar = named ?? remembered?.choice?.value ??
        (await pickNamed(ctx, 'pick_calendar', request, calendars, 'Which calendar does this event belong on?', calendars[0] ?? null))

      // A heads-up about clashes costs one read and saves a double booking.
      const clashes = reading.dateOnly
        ? []
        : await runOrFail<CalendarEvent[]>(ctx, 'calendar_events', { from: start.toISOString(), to: end.toISOString() }).catch(() => [])

      await runOrFail(ctx, 'calendar_create_event', {
        title, start: start.toISOString(), end: end.toISOString(), allDay: reading.dateOnly,
        ...(calendar ? { calendar } : {})
      })
      const when = describeTime(start, reading.dateOnly)
      const clash = clashes.filter((e) => !e.allDay)[0]
      const evidence: Evidence[] = [{ kind: 'text', label: `Calendar${calendar ? ` · ${calendar}` : ''}`, value: `${title} — ${when}` }]
      if (remembered) evidence.push(ctx.memory.used(remembered))
      // Naming the calendar is the person's choice; keep it for events like this one.
      if (named && calendars.length > 1 && ctx.memory.learn) {
        const m = learnedChoice('calendar', named, title, `Events like "${title}" go on the ${named} calendar`)
        if (m) ctx.memory.keep(m)
      }
      return {
        success: true,
        headline: `Added "${title}" ${when}${calendar ? ` to ${calendar}` : ''}${remembered ? ', like last time' : ''}.${clash ? ` Heads up — it overlaps "${clash.title}".` : ''}`,
        evidence
      }
    } catch (err) {
      return failed(err)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Calendar: what's on
 * ------------------------------------------------------------------ */

const AGENDA =
  /\b(?:what(?:'s| is| do i have)? (?:on )?(?:my )?(?:calendar|schedule|agenda)|what(?:'s| is) (?:on |happening )?(?:today|tomorrow|this week|next)|am i (?:free|busy)|do i have (?:any )?(?:meetings?|events?|anything)|my (?:day|week|schedule) look|meetings? (?:today|tomorrow|this week))\b/i

export function agendaRange(request: string, now = new Date()): { from: Date; to: Date; label: string; probe?: Date } {
  const day = (offset: number): Date => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d }
  if (/\bwhat(?:'s| is) next\b/i.test(request)) return { from: now, to: day(2), label: 'next' }
  if (/\b(?:this|the) week\b|\bmy week\b/i.test(request)) return { from: now, to: day(7), label: 'this week' }
  const reading = readTime(request, now)
  if (reading && !reading.dateOnly && /\bam i (?:free|busy)\b/i.test(request)) {
    const at = reading.candidates[0]!
    return { from: at, to: new Date(at.getTime() + (reading.durationMin ?? 60) * 60_000), label: describeTime(at, false, now), probe: at }
  }
  if (reading) {
    const d = new Date(reading.candidates[0]!); d.setHours(0, 0, 0, 0)
    const end = new Date(d); end.setDate(end.getDate() + 1)
    return { from: d.getTime() < now.getTime() ? now : d, to: end, label: describeTime(d, true, now) }
  }
  return { from: now, to: day(1), label: 'today' }
}

/* ------------------------------------------------------------------ *
 * Calendar: finding free time
 * ------------------------------------------------------------------ */

const FREE_SLOT =
  /\b(?:(?:first|next|a|an|any) )?free (?:hour|slot|time|half[- ]hour|\d+ ?(?:min(?:ute)?s?|hours?))\b|\bwhen am i free\b|\bfind (?:me )?(?:a |an )?(?:free )?(?:slot|time|hour|gap)\b/i

/** One hour, unless the sentence says otherwise. */
function slotMinutes(request: string, reading: TimeReading | null): number {
  const r = request.toLowerCase()
  if (/half[- ]hour/.test(r)) return 30
  const n = /(\d+) ?(min(?:ute)?s?|hours?)\b/.exec(r)
  if (n) return Number(n[1]) * (n[2]!.startsWith('h') ? 60 : 1)
  return reading?.durationMin ?? 60
}

function clockToMinutes(h: string, m: string | undefined, mer: string | undefined): number {
  let hour = Number(h)
  if (mer === 'pm' && hour < 12) hour += 12
  if (mer === 'am' && hour === 12) hour = 0
  // "between 9 and 5": the second number is afternoon.
  return hour * 60 + (m ? Number(m) : 0)
}

export interface FreeSlotQuery { day: Date; windowStart: Date; windowEnd: Date; minutes: number }

/** The day, the working window and the length being asked about. */
export function freeSlotQuery(request: string, now = new Date()): FreeSlotQuery {
  const reading = readTime(request, now)
  const day = new Date(reading?.candidates[0] ?? now)
  day.setHours(0, 0, 0, 0)
  let from = 9 * 60, to = 18 * 60
  const between = /\b(?:between|from) (\d{1,2})(?::(\d{2}))? ?(am|pm)? (?:and|to|-) (\d{1,2})(?::(\d{2}))? ?(am|pm)?/i.exec(request)
  if (between) {
    from = clockToMinutes(between[1]!, between[2], between[3]?.toLowerCase())
    to = clockToMinutes(between[4]!, between[5], between[6]?.toLowerCase() ?? (Number(between[4]) < 9 ? 'pm' : undefined))
  }
  const windowStart = new Date(day.getTime() + from * 60_000)
  const windowEnd = new Date(day.getTime() + to * 60_000)
  // Today, the window starts from now, rounded up to the next half hour.
  if (windowStart.getTime() < now.getTime()) {
    const next = new Date(now)
    next.setMinutes(next.getMinutes() <= 30 ? 30 : 60, 0, 0)
    windowStart.setTime(next.getTime())
  }
  return { day, windowStart, windowEnd, minutes: slotMinutes(request, reading) }
}

/** Gaps of at least `minutes` inside the window, around the busy events. */
export function freeGaps(q: FreeSlotQuery, busy: { start: string; end: string; allDay: boolean }[]): { start: Date; end: Date }[] {
  const blocks = busy
    .filter((e) => !e.allDay)
    .map((e) => ({ start: new Date(e.start).getTime(), end: new Date(e.end).getTime() }))
    .sort((a, b) => a.start - b.start)
  const gaps: { start: Date; end: Date }[] = []
  let cursor = q.windowStart.getTime()
  for (const b of blocks) {
    if (b.start - cursor >= q.minutes * 60_000) gaps.push({ start: new Date(cursor), end: new Date(b.start) })
    cursor = Math.max(cursor, b.end)
  }
  if (q.windowEnd.getTime() - cursor >= q.minutes * 60_000) gaps.push({ start: new Date(cursor), end: q.windowEnd })
  return gaps.filter((g) => g.start.getTime() < q.windowEnd.getTime())
}

export const freeSlotWorkflow: Workflow = {
  id: 'free_slot',
  description: 'Find when the user is free on a day, from their calendar.',
  routes: APPS_ROUTES,
  plausible: (request) => FREE_SLOT.test(request),
  async run(request, _dropped, ctx) {
    const q = freeSlotQuery(request)
    if (q.windowEnd.getTime() <= q.windowStart.getTime()) {
      return { success: true, headline: `That window has already passed ${describeTime(q.day, true)}.`, evidence: [] }
    }
    try {
      const events = await runOrFail<CalendarEvent[]>(ctx, 'calendar_events', { from: q.windowStart.toISOString(), to: q.windowEnd.toISOString() })
      const gaps = freeGaps(q, events)
      const time = (d: Date): string => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
      const day = describeTime(q.day, true)
      const length = q.minutes === 60 ? 'hour' : q.minutes % 60 === 0 ? `${q.minutes / 60} hours` : `${q.minutes} minutes`
      if (gaps.length === 0) return { success: true, headline: `No free ${length} ${day} between ${time(q.windowStart)} and ${time(q.windowEnd)}.`, evidence: [] }
      const first = gaps[0]!
      if (events.filter((e) => !e.allDay).length === 0) {
        return { success: true, headline: `You're free all ${day === 'today' ? 'of today' : day} from ${time(q.windowStart)} to ${time(q.windowEnd)}.`, evidence: [] }
      }
      return {
        success: true,
        headline: `Your first free ${length} ${day} starts at ${time(first.start)}.`,
        evidence: [{ kind: 'text', label: `Free ${day}`, value: gaps.map((g) => `${time(g.start)} – ${time(g.end)}`).join('\n') }]
      }
    } catch (err) {
      return failed(err)
    }
  }
}

export const agendaWorkflow: Workflow = {
  id: 'agenda',
  description: "Answer what is on the user's calendar, or whether they are free, for a day or time.",
  routes: APPS_ROUTES,
  plausible: (request) => AGENDA.test(request) && !FREE_SLOT.test(request),
  async run(request, _dropped, ctx) {
    const range = agendaRange(request)
    try {
      const events = await runOrFail<CalendarEvent[]>(ctx, 'calendar_events', { from: range.from.toISOString(), to: range.to.toISOString() })
      const time = (iso: string): string => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
      const lines = events.map((e) => (e.allDay ? `all day · ${e.title}` : `${time(e.start)} · ${e.title}`))
      if (range.probe) {
        return events.length === 0
          ? { success: true, headline: `You're free ${range.label}.`, evidence: [] }
          : { success: true, headline: `You're busy ${range.label}: ${events.map((e) => e.title).join(', ')}.`, evidence: [{ kind: 'text', label: 'Overlapping', value: lines.join('\n') }] }
      }
      if (events.length === 0) return { success: true, headline: `Nothing on your calendar ${range.label}.`, evidence: [] }
      if (range.label === 'next') {
        const next = events[0]!
        return { success: true, headline: `Next up: ${next.title}, ${describeTime(new Date(next.start), next.allDay)}.`, evidence: [] }
      }
      const byDay = range.label === 'this week'
      const body = byDay
        ? events.map((e) => `${new Date(e.start).toLocaleDateString('en-US', { weekday: 'short' })} ${e.allDay ? 'all day' : time(e.start)} · ${e.title}`).join('\n')
        : lines.join('\n')
      return {
        success: true,
        headline: `${capitalize(range.label)}: ${events.length} ${events.length === 1 ? 'thing' : 'things'} on your calendar.`,
        evidence: [{ kind: 'text', label: capitalize(range.label), value: body }]
      }
    } catch (err) {
      return failed(err)
    }
  }
}

/* ------------------------------------------------------------------ *
 * System settings
 * ------------------------------------------------------------------ */

type SettingPlan =
  | { tool: 'system_appearance'; input: { dark: boolean }; done: string }
  | { tool: 'system_volume'; input: { volume?: number; muted?: boolean }; done: string }

export function readSetting(request: string, currentVolume?: number): SettingPlan | null {
  const r = request.toLowerCase()
  if (/\b(dark mode|go dark|turn (?:on )?dark|lights off)\b/.test(r) && !/\b(off|disable)\b.*dark|\bdark mode off\b/.test(r)) {
    return { tool: 'system_appearance', input: { dark: true }, done: 'Dark mode is on.' }
  }
  if (/\b(light mode|dark mode off|turn off dark mode|disable dark mode|lights on)\b/.test(r)) {
    return { tool: 'system_appearance', input: { dark: false }, done: 'Light mode is on.' }
  }
  if (/\bunmute\b/.test(r)) return { tool: 'system_volume', input: { muted: false }, done: 'Sound is back on.' }
  if (/\b(mute|silence)\b/.test(r)) return { tool: 'system_volume', input: { muted: true }, done: 'Muted.' }
  const set = /\bvolume (?:to |at )?(\d{1,3})\s*%?/.exec(r) ?? /\b(?:set|turn) (?:the )?(?:volume|sound) (?:to |at )?(\d{1,3})/.exec(r)
  if (set) {
    const v = Math.min(100, Number(set[1]))
    return { tool: 'system_volume', input: { volume: v, muted: false }, done: `Volume is at ${v}.` }
  }
  const step = currentVolume ?? 50
  if (/\b(louder|turn (?:it |the volume |the sound )?up|volume up|increase (?:the )?volume)\b/.test(r)) {
    const v = Math.min(100, step + 15)
    return { tool: 'system_volume', input: { volume: v, muted: false }, done: `Volume up to ${v}.` }
  }
  if (/\b(quieter|turn (?:it |the volume |the sound )?down|volume down|lower (?:the )?volume|decrease (?:the )?volume)\b/.test(r)) {
    const v = Math.max(0, step - 15)
    return { tool: 'system_volume', input: { volume: v }, done: `Volume down to ${v}.` }
  }
  return null
}

export const settingWorkflow: Workflow = {
  id: 'system_setting',
  description: 'Switch dark or light mode, or change, mute or unmute the volume.',
  routes: APPS_ROUTES,
  plausible: (request) => readSetting(request) !== null,
  async run(request, _dropped, ctx) {
    try {
      let plan = readSetting(request)!
      if (plan.tool === 'system_volume' && /\b(louder|quieter|up|down|increase|decrease|lower)\b/i.test(request) && plan.input.volume !== undefined && !/\d/.test(request)) {
        // Relative changes need the current level first.
        const now = await runOrFail<{ volume: number }>(ctx, 'system_volume', {})
        plan = readSetting(request, now.volume)!
      }
      await runOrFail(ctx, plan.tool, plan.input)
      return { success: true, headline: plan.done, evidence: [] }
    } catch (err) {
      return failed(err)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Shortcuts
 * ------------------------------------------------------------------ */

const SHORTCUT = /\b(?:run|start|trigger|do|use)\b.*\bshortcut\b|\bshortcut\b.*\b(?:run|start)\b/i

export const shortcutWorkflow: Workflow = {
  id: 'run_shortcut',
  description: "Run one of the user's own shortcuts from the Shortcuts app.",
  routes: APPS_ROUTES,
  plausible: (request) => SHORTCUT.test(request),
  async run(request, _dropped, ctx) {
    try {
      const names = await runOrFail<string[]>(ctx, 'shortcuts_list', {})
      if (names.length === 0) return { success: false, headline: "You don't have any shortcuts yet.", evidence: [] }
      const named = names.filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(request)).sort((a, b) => b.length - a.length)[0]
      let pick = named ?? null
      // "focus mode" → the shortcut it meant last time.
      const remembered = named ? null : suggestChoice('shortcut', request, ctx.memory.all(), names)
      if (remembered) pick = remembered.choice!.value
      let guessed = false
      if (!pick) {
        guessed = true
        const options: Record<string, string> = { none: 'None of these is the one the user means.' }
        names.slice(0, 60).forEach((n, i) => { options[`s${i}`] = n })
        const answers = await ctx.ask('pick_shortcut', { userRequest: request }, { pick: choice('Which shortcut does the user want to run?', options) })
        const c = (answers?.pick as { choice?: string } | undefined)?.choice
        pick = c && c !== 'none' ? (names[Number(c.slice(1))] ?? null) : null
      }
      if (!pick) {
        return { success: false, headline: `I couldn't tell which shortcut. You have: ${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}.`, evidence: [] }
      }
      const out = await runOrFail<{ output: string }>(ctx, 'shortcuts_run', { name: pick })
      const evidence: Evidence[] = out.output.trim() ? [{ kind: 'text', label: `${pick} said`, value: out.output.trim().slice(0, 1500) }] : []
      if (remembered) evidence.push(ctx.memory.used(remembered))
      // A shortcut found from other words: keep the words, so next time needs no guessing.
      if (guessed && ctx.memory.learn) {
        const about = aboutWords(request).join(' ')
        const m = learnedChoice('shortcut', pick, about, `"${about}" means your ${pick} shortcut`)
        if (m && ctx.memory.keep(m)) evidence.push({ kind: 'text', label: 'Remembered', value: m.text })
      }
      return { success: true, headline: `Ran "${pick}".`, evidence }
    } catch (err) {
      return failed(err)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Notes
 * ------------------------------------------------------------------ */

const NOTE = /^\s*(?:note:|(?:make|take|write|add|jot)(?: down)? (?:a )?note\b|jot down\b|save (?:this|that|it) (?:to|in|as a) notes?\b)/i

export function noteFromWords(request: string): { title: string; body: string } | null {
  if (/^\s*save (?:this|that|it)\b/i.test(request)) return null
  const text = request
    .replace(/^\s*(?:note:|(?:make|take|write|add|jot)(?: down)? (?:a )?note(?: that| saying| about|:)?|jot down)\s*/i, '')
    .trim()
  if (!text || /^(?:this|that|it)$/i.test(text)) return null
  const firstLine = text.split(/\n|(?<=[.!?])\s/)[0]!.trim()
  const title = capitalize(firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine)
  return { title, body: text === firstLine ? '' : text }
}

export const noteWorkflow: Workflow = {
  id: 'make_note',
  description: 'Write a note in the Notes app from what the user said, or from what they have selected or open.',
  routes: APPS_ROUTES,
  plausible: (request) => NOTE.test(request),
  async run(request, _dropped, ctx) {
    try {
      let note = noteFromWords(request)
      if (!note) {
        // "Save this to notes": this is whatever they had selected, or the page they had open.
        const seen = await runOrFail<ScreenContext>(ctx, 'context_now', { selection: true, tab: true })
        if (seen.selection?.trim()) {
          const text = seen.selection.trim()
          const first = text.split('\n')[0]!.trim()
          note = { title: first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first, body: text === first ? '' : text }
        } else if (seen.tab) {
          note = { title: seen.tab.title || seen.tab.url, body: seen.tab.url }
        } else {
          return { success: false, headline: 'Select some text or open a page first, then ask again.', evidence: [] }
        }
      }
      const made = await runOrFail<{ folder: string }>(ctx, 'notes_create', note)
      return {
        success: true,
        headline: `Saved to Notes: "${note.title}".`,
        evidence: [{ kind: 'text', label: `Notes · ${made.folder}`, value: note.title }]
      }
    } catch (err) {
      return failed(err)
    }
  }
}

export const assistWorkflows: Workflow[] = [reminderWorkflow, eventWorkflow, freeSlotWorkflow, agendaWorkflow, settingWorkflow, shortcutWorkflow, noteWorkflow]
