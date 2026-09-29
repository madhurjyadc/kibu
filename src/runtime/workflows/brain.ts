import { basename } from 'node:path'
import { readTime, spelledDurations, stripTime } from '../when.js'
import { reminderTitle } from './assist.js'
import type { ScreenContext } from '../tools/mac.js'
import type { BrainDraft, BrainRequest, BrainSnapshot, BrainSource } from '../../shared/brain.js'
import type { WorkflowContext, WorkflowResult } from './types.js'

const external = /\b(?:apple (?:notes|reminders)|(?:in|to|using) (?:the )?(?:notes|reminders) app|calendar)\b/i
export function isBrainRequest(text: string): boolean {
  if (external.test(text)) return false
  return /^(?:(?:hey kibu|kibu|please)[, ]+)*(?:(?:start|set|pause|resume|cancel|stop) (?:a |an |the |my )?(?:\d+(?:\.\d+)?[ -](?:minute|second|hour)s?[ -])?(?:focus )?timer\b|(?:focus|time me) for\b|remind me\b|remember to\b|(?:set|add) a reminder\b|save where I am\b|resume (?:my )?(?:project|session)\b|note:|(?:make|take|create|save|add) (?:a )?note\b|(?:save|keep) (?:this|that|these)\b|(?:add|create) (?:a )?(?:task|project|tracker)\b|track .+ daily$|(?:show|list|what(?:'s| is| are)) (?:in )?(?:my |kibu(?:'s)? )?(?:workspace|notes|tasks|reminders|projects|trackers)\b)/i.test(spelledDurations(text.trim()))
}

/** Narrow, local commands stay useful without a model connection. Novel combinations hand off. */
export async function runBrainWorkflow(request: string, dropped: string[], ctx: WorkflowContext, previousApp?: string | null): Promise<WorkflowResult | null> {
  if (!isBrainRequest(request)) return null
  const text = request.trim().replace(/^(?:(?:hey kibu|kibu|please)[, ]+)*/i, '')
  const run = async (req: BrainRequest): Promise<BrainSnapshot> => {
    const result = await ctx.run('kibu_workspace', { request: req })
    if (!result.ok) throw new Error(result.error ?? 'Could not save to Kibu.')
    return result.result as BrainSnapshot
  }
  const session = /^save where I am(?: with (.+?))?(?:[.!]\s*|$)(.*)$/is.exec(text)
  if (session) {
    const name = session[1]?.trim() ?? 'Work session'
    const next = session[2]?.trim() ?? ''
    const seen = await ctx.run('context_now', { ...(previousApp ? { app: previousApp } : {}), selection: true, tab: true, finder: true })
    const context = seen.ok ? seen.result as ScreenContext : null
    const sources: BrainSource[] = [...new Set([...dropped, ...(context?.finderSelection ?? [])])].map(value => ({ kind: 'path', label: basename(value), value }))
    if (context?.tab) sources.push({ kind: 'url', label: context.tab.title, value: context.tab.url })
    if (!next && !sources.length && !context?.selection) return { success: false, headline: 'Tell me your next step, or drop the files you want to return to.', evidence: [] }
    let projectId: string | null = null
    if (session[1]) {
      const projects = (await run({ op: 'list', kind: 'project' })).items.filter(p => p.status === 'open' && p.title.toLowerCase() === name.toLowerCase())
      if (projects.length > 1) return null
      if (projects.length === 1) projectId = projects[0]!.id
      else projectId = (await run({ op: 'create', item: { kind: 'project', title: name } })).items[0]!.id
    }
    const body = [next, context?.selection || context?.page?.selection].filter(Boolean).join('\n\n')
    await run({ op: 'create', item: { kind: 'session', title: `${name} · ${new Date().toLocaleDateString()}`, body, sources, projectId } })
    return { success: true, headline: `Saved where you left off with ${name}. ${next || 'Your sources are in Workspace → Sessions.'}`, evidence: sources.map(s => ({ kind: s.kind, label: s.label, value: s.value })) }
  }
  const resume = /^resume (?:my )?(?:project|session) ["']?(.+?)["']?[.!]?$/i.exec(text)
  if (resume) {
    const projects = await run({ op: 'list', kind: 'project' })
    const name = resume[1]!.toLowerCase()
    const project = projects.items.find(i => i.kind === 'project' && i.title.toLowerCase() === name && i.status === 'open')
    const state = await run({ op: 'list', kind: 'session', ...(project ? { projectId: project.id } : {}) })
    const sessions = state.items.filter(i => i.kind === 'session' && i.status === 'open' && (i.projectId === project?.id || i.title.toLowerCase().includes(name))).sort((a, b) => b.updatedAt - a.updatedAt)
    if (!sessions.length) return { success: false, headline: `No saved session for “${resume[1]}” yet.`, evidence: [] }
    const saved = (await run({ op: 'list', id: sessions[0]!.id })).items[0]!
    return { success: true, headline: `${saved.title}\n\n${saved.body || 'Your saved files and links are ready below.'}`, evidence: saved.sources.map(s => ({ kind: s.kind, label: s.label, value: s.value })) }
  }
  // Let planning interpret multiple jobs and content transformations, before changing anything.
  if (/\b(?:and (?:then |also )?(?:remind|save|create|add|open)|summari[sz]e|extract|turn .+ into|rewrite)\b/i.test(text)) return null
  const control = /^(pause|resume|cancel|stop) (?:the |my )?(?:focus )?timer\b/i.exec(text)
  if (control) {
    await run({ op: 'timer', action: control[1]!.toLowerCase() === 'stop' ? 'cancel' : control[1]!.toLowerCase() as 'pause' | 'resume' | 'cancel' })
    return { success: true, headline: `Timer ${control[1]!.toLowerCase() === 'pause' ? 'paused' : control[1]!.toLowerCase() === 'resume' ? 'resumed' : 'cancelled'}.`, evidence: [] }
  }
  if (/\btimer\b|^(?:focus|time me) for\b/i.test(text)) {
    // "a timer of one minute" is as clear as "a 1 minute timer".
    const duration = /(\d+(?:\.\d+)?)\s*[- ]?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i.exec(spelledDurations(text))
    if (!duration) return null
    const minutes = Number(duration[1]) * (/^s/i.test(duration[2]!) ? 1 / 60 : /^h/i.test(duration[2]!) ? 60 : 1)
    const label = /(?:called|named)\s+(.+)$/i.exec(text)?.[1] ?? 'Focus time'
    await run({ op: 'timer', action: 'start', minutes, label })
    return { success: true, headline: `${duration[1]} ${duration[2]} on the clock. I'll keep time.`, evidence: [] }
  }
  if (/^(show|list|what)/i.test(text)) {
    const kind = /\b(notes|tasks|reminders|projects|trackers)\b/i.exec(text)?.[1]?.toLowerCase().replace(/s$/, '') as BrainDraft['kind'] | undefined
    const state = await run({ op: 'list', ...(kind ? { kind } : {}) })
    const items = state.items.filter(i => i.status === 'open')
    return { success: true, headline: items.length ? items.slice(0, 30).map(i => `• ${i.title}${i.dueAt ? ` — ${new Date(i.dueAt).toLocaleString()}` : ''}`).join('\n') : 'Nothing here yet. You can add a note, task, reminder, project, or daily tracker.', evidence: [] }
  }
  let item: BrainDraft | null = null
  if (/^(remind me|remember to|set a reminder|add a reminder)/i.test(text)) {
    // Do not silently treat an unsupported recurrence as a one-time reminder.
    if (/\bevery\b/i.test(text) && !/\bevery (?:day|week)\b/i.test(text)) return null
    const repeat = /\b(?:daily|every day)\b/i.test(text) ? 'daily' : /\b(?:weekly|every week)\b/i.test(text) ? 'weekly' : 'none'
    const clean = text.replace(/\b(?:daily|weekly|every day|every week)\b/gi, '')
    let reading = readTime(clean)
    if (!reading) {
      const answer = await ctx.askUser({ reason: 'ambiguous', prompt: 'When should I remind you?', allowFreeText: true, options: [{ id: 'hour', label: 'In an hour' }, { id: 'tomorrow', label: 'Tomorrow at 9am' }] })
      const time = answer.optionId === 'hour' ? 'in 1 hour' : answer.optionId === 'tomorrow' ? 'tomorrow at 9am' : answer.text
      if (!time || !(reading = readTime(time))) return { success: false, headline: 'No reminder saved. Give me a time such as “tomorrow at 9am”.', evidence: [] }
    }
    let due = reading.candidates[0]!
    if (reading.candidates.length > 1) {
      const answer = await ctx.askUser({ reason: 'ambiguous', prompt: 'Which time did you mean?', allowFreeText: false, options: reading.candidates.map((d, i) => ({ id: String(i), label: d.toLocaleString() })) })
      if (answer.optionId === null || !reading.candidates[Number(answer.optionId)]) return { success: false, headline: 'No reminder saved.', evidence: [] }
      due = reading.candidates[Number(answer.optionId)]!
    }
    if (due.getTime() <= Date.now()) return { success: false, headline: 'That time has passed. Please choose a future time.', evidence: [] }
    item = { kind: 'reminder', title: reminderTitle(clean, readTime(clean)), dueAt: due.getTime(), repeat }
  } else {
    const create = /^(?:add|create|make|take|save) (?:a )?(note|task|project|tracker)(?:\s+(?:called|named))?\s*:?\s+(.+)$/is.exec(text)
    if (create) item = { kind: create[1]!.toLowerCase() as BrainDraft['kind'], title: create[2]!.split('\n')[0]!.slice(0, 300), body: create[1]!.toLowerCase() === 'note' ? create[2]! : '' }
    else if (/^note:/i.test(text)) { const body = text.replace(/^note:\s*/i, ''); item = { kind: 'note', title: body.split('\n')[0]!.slice(0, 100), body } }
    else {
      const track = /^track (.+?) daily[.!]?$/i.exec(text)
      if (track) item = { kind: 'tracker', title: track[1]! }
    }
  }
  if (!item && /^(save|keep) (this|that|these)\b/i.test(text)) {
    // Broader transformations should be interpreted by the planner, not stored as a link.
    if (!/^(save|keep) (this|that|these)(?: (?:for later|to (?:my )?notes|for .+))?[.!]?$/i.test(text)) return null
    const sources: BrainSource[] = dropped.map(path => ({ kind: 'path', label: basename(path), value: path }))
    const result = dropped.length ? { ok: true, result: null } : await ctx.run('context_now', { ...(previousApp ? { app: previousApp } : {}), selection: true, tab: true, finder: dropped.length === 0 })
    const context = result.ok ? result.result as ScreenContext : null
    const selection = context?.selection || context?.page?.selection || ''
    if (context?.tab) sources.push({ kind: 'url', label: context.tab.title, value: context.tab.url })
    if (!sources.length) for (const path of context?.finderSelection ?? []) sources.push({ kind: 'path', label: basename(path), value: path })
    if (!selection && !sources.length) return { success: false, headline: 'Select some text, open a page, or drop files onto me first.', evidence: [] }
    let projectId: string | null = null
    const project = /\bfor (?!later\b)(.+?)[.!]?$/i.exec(text)?.[1]
    if (project) {
      const existing = (await run({ op: 'list', kind: 'project' })).items.filter(p => p.status === 'open' && p.title.toLowerCase() === project.toLowerCase())
      if (existing.length !== 1) return null
      projectId = existing[0]!.id
    }
    item = { kind: selection ? 'note' : 'bookmark', title: selection ? selection.split('\n')[0]!.slice(0, 100) : sources[0]!.label, body: selection, sources, projectId }
  }
  if (!item) return null
  if (item.kind === 'reminder' && /^(?:this|that|it)[.!]?$/i.test(item.title)) {
    const seen = await ctx.run('context_now', { ...(previousApp ? { app: previousApp } : {}), selection: true, tab: true })
    const context = seen.ok ? seen.result as ScreenContext : null
    const selection = context?.selection || context?.page?.selection || ''
    if (!selection && !context?.tab) return { success: false, headline: 'Select what you want to be reminded about, or give it a name.', evidence: [] }
    item = { ...item, title: selection ? selection.split('\n')[0]!.slice(0, 300) : context!.tab!.title, body: selection, sources: context?.tab ? [{ kind: 'url', label: context.tab.title, value: context.tab.url }] : [] }
  }
  if (item.kind === 'task') {
    const estimate = /\b(?:takes?|estimate|estimated)\s+(\d+)\s*(?:minutes?|mins?)\b/i.exec(item.title)
    const title = estimate ? item.title.replace(estimate[0], '').trim() : item.title
    const reading = readTime(title)
    if (reading && reading.candidates.length > 1) return null
    item = { ...item, title: stripTime(title, reading), ...(reading ? { dueAt: reading.candidates[0]!.getTime() } : {}), ...(estimate ? { estimateMinutes: Number(estimate[1]) } : {}) }
  }
  if (!item.title.trim()) return { success: false, headline: 'Give this a title first.', evidence: [] }
  await run({ op: 'create', item })
  const when = item.dueAt ? ` — ${new Date(item.dueAt).toLocaleString()}` : ''
  return { success: true, headline: `Saved in Kibu: ${item.title}${when}.`, evidence: [{ kind: 'text', label: 'Workspace', value: item.kind === 'reminder' ? 'I’ll remind you when it’s due, or when you return to Kibu.' : 'Kept locally in your workspace.' }] }
}
