import { execFile } from 'node:child_process'

/**
 * Talks to Mac apps through their scripting dictionaries (JXA) and a few
 * command-line tools (`shortcuts`, `pbpaste`).
 *
 * This is the fastest and most reliable way Kibu can act on an app: creating
 * a reminder through Reminders' own scripting interface takes a fraction of a
 * second and either works or says why, where clicking through its window is
 * slow and breaks whenever the layout changes. The desktop tools remain for
 * apps that have no dictionary.
 *
 * Every script receives its input as one JSON argument and never through
 * string interpolation, so nothing in a request can become script source.
 */
export interface MacBridge {
  jxa<T>(body: string, input: unknown, timeoutMs?: number): Promise<T>
  exec(program: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string; code: number }>
}

export class ScriptError extends Error {}

/** Turns osascript's error text into something a person can act on. */
export function explainScriptError(stderr: string, app?: string): string {
  const who = app ?? /Application\("?([^")]+)/.exec(stderr)?.[1] ?? 'that app'
  if (/-1743|not authori[sz]ed to send apple events/i.test(stderr)) {
    return `Kibu isn't allowed to control ${who} yet. Allow it in System Settings → Privacy & Security → Automation.`
  }
  if (/-1719|assistive access|not allowed assistive/i.test(stderr)) {
    return 'Kibu needs Accessibility permission for that. Allow it in System Settings → Privacy & Security → Accessibility.'
  }
  if (/JavaScript through AppleScript is turned off|Allow JavaScript from Apple Events|JavaScript from Apple Events/i.test(stderr)) {
    return /safari/i.test(stderr)
      ? 'Safari needs one setting first: Safari → Settings → Advanced → "Show features for web developers", then Develop → "Allow JavaScript from Apple Events".'
      : 'Your browser needs one setting first: in its menu bar, View → Developer → "Allow JavaScript from Apple Events". Kibu only reads the page; it never clicks or types in it.'
  }
  if (/-600|isn.t running|application isn.t running/i.test(stderr)) return `${who} isn't running.`
  if (/can.t get|doesn.t understand|-1728/i.test(stderr)) return `${who} couldn't find what was asked for.`
  const line = stderr.replace(/^.*execution error:\s*/s, '').replace(/\s*\(-?\d+\)\s*$/, '').trim()
  return line || 'the script failed without saying why'
}

function run(program: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(program, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ stdout: String(stdout), stderr: String(stderr), code })
    })
  })
}

export const osascriptBridge: MacBridge = {
  async jxa<T>(body: string, input: unknown, timeoutMs = 20_000): Promise<T> {
    const script = `function run(argv) { const input = JSON.parse(argv[0]); return JSON.stringify((function () { ${body} })() ?? null) }`
    const { stdout, stderr, code } = await run('osascript', ['-l', 'JavaScript', '-e', script, JSON.stringify(input ?? {})], timeoutMs)
    if (code !== 0) throw new ScriptError(explainScriptError(stderr))
    const text = stdout.trim()
    return (text ? JSON.parse(text) : null) as T
  },
  exec: (program, args, timeoutMs = 60_000) => run(program, args, timeoutMs)
}

let bridge: MacBridge = osascriptBridge

export function macBridge(): MacBridge {
  return bridge
}

/** Swaps the bridge. Tests use this so the suite never drives real apps. */
export function setMacBridge(next: MacBridge): void {
  bridge = next
}

/* ------------------------------------------------------------------ *
 * Scripts. Kept as named constants so they can be read and reviewed in
 * one place; each returns plain JSON.
 * ------------------------------------------------------------------ */

export const SCRIPTS = {
  calendars: `
    const Cal = Application('Calendar')
    const cals = Cal.calendars
    const names = cals.name(), writable = cals.writable()
    return names.map((name, i) => ({ name, writable: writable[i] }))`,

  events: `
    const Cal = Application('Calendar')
    const from = new Date(input.from), to = new Date(input.to), out = []
    for (const c of Cal.calendars()) {
      const name = c.name()
      if (input.calendars && input.calendars.length && !input.calendars.includes(name)) continue
      // One Apple event per property for the whole set, not one per event.
      const q = c.events.whose({ _and: [{ startDate: { _lessThan: to } }, { endDate: { _greaterThan: from } }] })
      const ids = q.uid()
      if (!ids.length) continue
      const titles = q.summary(), starts = q.startDate(), ends = q.endDate(), allDay = q.alldayEvent(), where = q.location()
      ids.forEach((id, i) => out.push({ id, title: titles[i], start: starts[i].toISOString(), end: ends[i].toISOString(),
        allDay: allDay[i], location: where[i] || '', calendar: name }))
    }
    out.sort((a, b) => a.start.localeCompare(b.start))
    return out.slice(0, input.limit || 60)`,

  createEvent: `
    const Cal = Application('Calendar')
    let cal = null
    if (input.calendar) {
      cal = Cal.calendars().find((c) => c.name() === input.calendar)
      if (!cal) throw new Error('There is no calendar called ' + input.calendar)
    } else {
      cal = Cal.calendars().find((c) => c.writable())
      if (!cal) throw new Error('There is no calendar Kibu can add to')
    }
    const ev = Cal.Event({ summary: input.title, startDate: new Date(input.start), endDate: new Date(input.end),
      alldayEvent: !!input.allDay, location: input.location || '', description: input.notes || '' })
    cal.events.push(ev)
    return { id: ev.uid(), calendar: cal.name() }`,

  eventExists: `
    const Cal = Application('Calendar')
    for (const c of Cal.calendars()) {
      const hit = c.events.whose({ uid: input.id })()
      if (hit.length) return { found: true, title: hit[0].summary(), start: hit[0].startDate().toISOString(), calendar: c.name() }
    }
    return { found: false }`,

  deleteEvent: `
    const Cal = Application('Calendar')
    for (const c of Cal.calendars()) {
      const hit = c.events.whose({ uid: input.id })()
      if (hit.length) { Cal.delete(hit[0]); return { deleted: true } }
    }
    return { deleted: false }`,

  reminderLists: `return Application('Reminders').lists.name()`,

  reminders: `
    const R = Application('Reminders')
    const lists = input.list ? R.lists().filter((l) => l.name() === input.list) : R.lists()
    const out = []
    for (const l of lists) {
      const q = l.reminders.whose({ completed: false })
      const ids = q.id()
      if (!ids.length) continue
      const names = q.name(), dues = q.dueDate(), listName = l.name()
      ids.forEach((id, i) => out.push({ id, title: names[i], due: dues[i] ? dues[i].toISOString() : null, list: listName }))
    }
    return out.slice(0, input.limit || 100)`,

  createReminder: `
    const R = Application('Reminders')
    let list = R.defaultList()
    if (input.list) {
      list = R.lists().find((l) => l.name() === input.list)
      if (!list) throw new Error('There is no Reminders list called ' + input.list)
    }
    const props = { name: input.title }
    if (input.due) props.dueDate = new Date(input.due)
    if (input.notes) props.body = input.notes
    const r = R.Reminder(props)
    list.reminders.push(r)
    return { id: r.id(), list: list.name() }`,

  reminderExists: `
    const R = Application('Reminders')
    try { const r = R.reminders.byId(input.id); return { found: true, title: r.name(), completed: r.completed() } }
    catch (e) { return { found: false } }`,

  deleteReminder: `
    const R = Application('Reminders')
    try { R.delete(R.reminders.byId(input.id)); return { deleted: true } } catch (e) { return { deleted: false } }`,

  completeReminder: `
    const R = Application('Reminders')
    const r = R.reminders.byId(input.id)
    r.completed = input.completed !== false
    return { completed: r.completed() }`,

  createNote: `
    const N = Application('Notes')
    let folder = N.defaultAccount().defaultFolder()
    if (input.folder) {
      folder = N.folders().find((f) => f.name() === input.folder)
      if (!folder) throw new Error('There is no Notes folder called ' + input.folder)
    }
    const n = N.Note({ body: input.html })
    folder.notes.push(n)
    return { id: n.id(), name: n.name(), folder: folder.name() }`,

  searchNotes: `
    const N = Application('Notes')
    const q = N.notes.whose({ _or: [{ name: { _contains: input.query } }, { plaintext: { _contains: input.query } }] })
    const ids = q.id()
    const names = q.name(), mods = q.modificationDate()
    return ids.map((id, i) => ({ id, title: names[i], modified: mods[i].toISOString() }))
      .sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, input.limit || 10)`,

  readNote: `
    const n = Application('Notes').notes.byId(input.id)
    return { title: n.name(), text: n.plaintext().slice(0, input.maxChars || 20000) }`,

  noteExists: `
    try { const n = Application('Notes').notes.byId(input.id); return { found: true, title: n.name() } } catch (e) { return { found: false } }`,

  deleteNote: `
    const N = Application('Notes')
    try { N.delete(N.notes.byId(input.id)); return { deleted: true } } catch (e) { return { deleted: false } }`,

  mailDraft: `
    const M = Application('Mail')
    const msg = M.OutgoingMessage({ subject: input.subject, content: input.body, visible: true })
    M.outgoingMessages.push(msg)
    for (const address of input.to || []) msg.toRecipients.push(M.Recipient({ address }))
    for (const address of input.cc || []) msg.ccRecipients.push(M.CcRecipient({ address }))
    M.activate()
    return { opened: true }`,

  runningApps: `
    const se = Application('System Events')
    const q = se.processes.whose({ backgroundOnly: false })
    return q.name()`,

  browserTabs: `
    const se = Application('System Events')
    const running = se.processes.whose({ backgroundOnly: false }).name()
    const out = []
    for (const name of ['Google Chrome', 'Arc', 'Brave Browser', 'Microsoft Edge', 'Chromium']) {
      if (!running.includes(name)) continue
      try {
        Application(name).windows().forEach((w, wi) => {
          const active = w.activeTab().id()
          w.tabs().forEach((t) => {
            const isActive = t.id() === active
            if (!input.activeOnly || (isActive && wi === 0)) out.push({ browser: name, title: t.title(), url: t.url(), active: isActive && wi === 0 })
          })
        })
      } catch (e) {}
    }
    if (running.includes('Safari')) {
      try {
        Application('Safari').windows().forEach((w, wi) => {
          const current = w.currentTab().index()
          w.tabs().forEach((t) => {
            const isActive = t.index() === current
            if (!input.activeOnly || (isActive && wi === 0)) out.push({ browser: 'Safari', title: t.name(), url: t.url(), active: isActive && wi === 0 })
          })
        })
      } catch (e) {}
    }
    return out.slice(0, 200)`,

  // The page open in the person's own browser: title, address, selection and
  // main text. Read-only, and the script run in the page is fixed text below,
  // never built from a request.
  readTab: `
    const se = Application('System Events')
    const running = se.processes.whose({ backgroundOnly: false }).name()
    const js = "(function(){var m=document.querySelector('article')||document.querySelector('main,[role=main]')||document.body;" +
      "return JSON.stringify({title:document.title,url:location.href,selection:String(window.getSelection()||'').slice(0,8000)," +
      "text:((m&&m.innerText)||'').replace(/\\n{3,}/g,'\\n\\n').slice(0,40000)})})()"
    const browsers = ['Google Chrome', 'Arc', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Safari']
    const order = input.prefer && browsers.includes(input.prefer) ? [input.prefer, ...browsers.filter((b) => b !== input.prefer)] : browsers
    for (const name of order) {
      if (!running.includes(name)) continue
      let raw
      if (name === 'Safari') {
        const s = Application('Safari')
        if (!s.documents.length) continue
        raw = s.doJavaScript(js, { in: s.documents[0] })
      } else {
        const app = Application(name)
        if (!app.windows.length) continue
        raw = app.windows[0].activeTab().execute({ javascript: js })
      }
      const page = JSON.parse(raw)
      return { browser: name, title: page.title, url: page.url, selection: page.selection, text: page.text }
    }
    return null`,

  // Runs one of Kibu's fixed page programs in the active tab of the person's
  // browser. `program` is always one of the constants in your-browser.ts and
  // `arg` is JSON-encoded data; neither is ever text from a model or a page.
  pageRun: `
    const se = Application('System Events')
    const running = se.processes.whose({ backgroundOnly: false }).name()
    const browsers = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Arc', 'Safari']
    const name = input.browser && running.includes(input.browser) ? input.browser : browsers.find((b) => running.includes(b))
    if (!name) throw new Error('No supported browser is running.')
    const code = '(' + input.program + ')(' + input.arg + ')'
    let raw
    if (name === 'Safari') {
      const s = Application('Safari')
      raw = s.doJavaScript(code, { in: s.windows[0].currentTab() })
    } else {
      raw = Application(name).windows[0].activeTab().execute({ javascript: code })
    }
    return { browser: name, result: raw === undefined || raw === null || raw === '' ? null : JSON.parse(raw) }`,

  // A new tab in the person's browser, brought to the front. Their current
  // tab is left exactly as it was.
  newTab: `
    const name = input.browser
    const app = Application(name)
    app.activate()
    if (name === 'Safari') {
      if (!app.windows.length) app.Document().make()
      const w = app.windows[0]
      const t = app.Tab({ url: input.url })
      w.tabs.push(t)
      w.currentTab = t
      return { browser: name }
    }
    if (!app.windows.length) {
      app.Window().make()
      app.windows[0].activeTab().url = input.url
      return { browser: name }
    }
    const w = app.windows[0]
    w.tabs.push(app.Tab({ url: input.url }))
    w.activeTabIndex = w.tabs.length
    return { browser: name }`,

  // Selected text in the app the person was using. Needs Accessibility.
  selection: `
    const se = Application('System Events')
    try {
      const p = se.processes.byName(input.app)
      const el = p.attributes.byName('AXFocusedUIElement').value()
      const text = el.attributes.byName('AXSelectedText').value()
      return typeof text === 'string' ? text.slice(0, 20000) : null
    } catch (e) { return null }`,

  finderSelection: `
    const se = Application('System Events')
    if (!se.processes.name().includes('Finder')) return []
    return Application('Finder').selection().map((i) => decodeURI(i.url()).replace(/^file:\\/\\//, '').replace(/\\/$/, ''))`,

  appearance: `
    const se = Application('System Events')
    const previous = se.appearancePreferences.darkMode()
    if (typeof input.dark === 'boolean') se.appearancePreferences.darkMode = input.dark
    return { previous, now: se.appearancePreferences.darkMode() }`,

  volume: `
    const app = Application.currentApplication()
    app.includeStandardAdditions = true
    const before = app.getVolumeSettings()
    if (typeof input.volume === 'number') app.setVolume(null, { outputVolume: Math.max(0, Math.min(100, Math.round(input.volume))) })
    if (typeof input.muted === 'boolean') app.setVolume(null, { outputMuted: input.muted })
    const after = app.getVolumeSettings()
    return { previousVolume: before.outputVolume, previousMuted: before.outputMuted, volume: after.outputVolume, muted: after.outputMuted }`,

  quitApp: `
    const a = Application(input.app)
    if (!a.running()) return { quit: false, reason: 'not running' }
    a.quit()
    return { quit: true }`
} as const

/* ------------------------------------------------------------------ *
 * Undo for app items and settings. Runs in the main process.
 * ------------------------------------------------------------------ */

export type MacUndoKind = 'mac.event' | 'mac.reminder' | 'mac.note' | 'mac.setting'

/**
 * Reverses one app change. Items are identified by the id the app gave them;
 * settings carry their previous value. Returns a reason when it declines.
 */
export async function reverseMacChange(
  kind: MacUndoKind,
  payload: { from: string; to: string },
  b: MacBridge = bridge
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    if (kind === 'mac.event') {
      const r = await b.jxa<{ deleted: boolean }>(SCRIPTS.deleteEvent, { id: payload.to })
      return r.deleted ? { ok: true } : { ok: false, reason: 'the event is already gone' }
    }
    if (kind === 'mac.reminder') {
      const r = await b.jxa<{ deleted: boolean }>(SCRIPTS.deleteReminder, { id: payload.to })
      return r.deleted ? { ok: true } : { ok: false, reason: 'the reminder is already gone' }
    }
    if (kind === 'mac.note') {
      const r = await b.jxa<{ deleted: boolean }>(SCRIPTS.deleteNote, { id: payload.to })
      return r.deleted ? { ok: true } : { ok: false, reason: 'the note is already gone' }
    }
    // mac.setting: `from` names the setting, `to` holds its previous value.
    if (payload.from === 'dark') await b.jxa(SCRIPTS.appearance, { dark: payload.to === 'true' })
    else if (payload.from === 'volume') await b.jxa(SCRIPTS.volume, { volume: Number(payload.to) })
    else if (payload.from === 'muted') await b.jxa(SCRIPTS.volume, { muted: payload.to === 'true' })
    else return { ok: false, reason: `unknown setting ${payload.from}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
