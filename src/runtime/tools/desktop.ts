import { z } from 'zod'
import type { ElementRef, UiElement, WindowSnapshot } from '../../os/adapter.js'
import { StaleElementError } from '../../os/adapter.js'
import type { ToolContext, ToolDefinition } from './registry.js'

/**
 * Element references handed to the model are opaque strings. We keep the real
 * ElementRef here, keyed by task, and refuse to act on one that came from a
 * snapshot other than the most recent — that is what stops the assistant from
 * clicking where a button used to be.
 */
interface ElementCacheEntry {
  ref: ElementRef
  label: string
  role: string
  snapshotId: number
  observedAt: number
}

const elementCache = new Map<string, Map<string, ElementCacheEntry>>()
const latestSnapshot = new Map<string, number>()
let snapshotCounter = 0

/** Observations older than this must be refreshed before they are acted on. */
const SNAPSHOT_TTL_MS = 30_000

function cacheFor(taskId: string): Map<string, ElementCacheEntry> {
  let m = elementCache.get(taskId)
  if (!m) {
    m = new Map()
    elementCache.set(taskId, m)
  }
  return m
}

export function clearElementCache(taskId: string): void {
  elementCache.delete(taskId)
  latestSnapshot.delete(taskId)
}

/** Flattens the AX tree into the interactive elements a model can act on. */
function flatten(elements: UiElement[], out: UiElement[] = []): UiElement[] {
  for (const el of elements) {
    out.push(el)
    if (el.children) flatten(el.children, out)
  }
  return out
}

const ACTIONABLE = new Set(['AXPress', 'AXConfirm', 'AXPick', 'AXIncrement', 'AXDecrement', 'AXShowMenu'])

function summarizeSnapshot(snap: WindowSnapshot, taskId: string) {
  const snapshotId = ++snapshotCounter
  latestSnapshot.set(taskId, snapshotId)
  const cache = cacheFor(taskId)
  cache.clear()

  const flat = flatten(snap.elements)
  const useful = flat.filter(
    (el) =>
      el.actions.some((a) => ACTIONABLE.has(a)) ||
      ['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox'].includes(el.role) ||
      (el.role === 'AXStaticText' && el.title.length > 0)
  )

  const items = useful.slice(0, 120).map((el) => {
    cache.set(el.ref.id, {
      ref: el.ref,
      label: el.title,
      role: el.role,
      snapshotId,
      observedAt: snap.observedAt
    })
    return {
      ref: el.ref.id,
      role: el.role,
      label: el.title,
      value: el.value,
      enabled: el.enabled,
      focused: el.focused,
      actions: el.actions.filter((a) => ACTIONABLE.has(a)),
      // Centre point in global top-left-origin points, for click fallback.
      center: {
        x: Math.round(el.frame.x + el.frame.width / 2),
        y: Math.round(el.frame.y + el.frame.height / 2)
      }
    }
  })

  return {
    app: snap.app,
    windowId: snap.windowId,
    title: snap.title,
    frame: snap.frame,
    displayId: snap.displayId,
    elementCount: flat.length,
    truncated: useful.length > 120,
    elements: items
  }
}

function resolveRef(ctx: ToolContext, refId: string): ElementRef {
  const entry = cacheFor(ctx.task.id).get(refId)
  if (!entry) {
    throw new StaleElementError(
      `Unknown element "${refId}". Call desktop_inspect_window again and use a reference from the new result.`
    )
  }
  if (entry.snapshotId !== latestSnapshot.get(ctx.task.id)) {
    throw new StaleElementError(
      `Element "${refId}" came from an earlier look at the window. Re-inspect before acting.`
    )
  }
  if (Date.now() - entry.observedAt > SNAPSHOT_TTL_MS) {
    throw new StaleElementError(`Element "${refId}" was observed over 30s ago. Re-inspect before acting.`)
  }
  return entry.ref
}

export const desktopListApps: ToolDefinition = {
  name: 'desktop_list_apps',
  description: 'List running applications with their process ids and window counts. A window count of 0 usually means Accessibility permission is missing.',
  capability: 'desktop.observe',
  input: z.object({}),
  scopes: () => [],
  async execute(_i, ctx) {
    const apps = await ctx.os.listApps()
    ctx.observe({
      kind: 'window',
      summary: `${apps.length} running apps`,
      data: apps.map((a) => ({ name: a.name, pid: a.pid, windows: a.windowCount })),
      staleAfterMs: 30_000
    })
    return { result: apps }
  }
}

export const desktopInspectWindow: ToolDefinition = {
  name: 'desktop_inspect_window',
  description:
    'Read the controls in an application window using macOS accessibility. Returns element references you can press or set. Prefer this over screenshots and clicking: it is far more reliable. Re-run it after anything that changes the window.',
  capability: 'desktop.observe',
  input: z.object({
    pid: z.number().int().optional().describe('Process id; omit to inspect the frontmost window'),
    maxNodes: z.number().int().min(50).max(800).default(400)
  }),
  scopes: () => [],
  async execute(i, ctx) {
    const snap = i.pid
      ? await ctx.os.inspectWindow(i.pid, { maxNodes: i.maxNodes })
      : await ctx.os.getFrontmostWindow()
    if (!snap) throw new Error('no frontmost window to inspect')
    const summary = summarizeSnapshot(snap, ctx.task.id)
    ctx.observe({
      kind: 'window',
      summary: `${snap.app.name} — "${snap.title}" (${summary.elements.length} controls)`,
      data: { app: snap.app.name, title: snap.title, controls: summary.elements.length },
      staleAfterMs: SNAPSHOT_TTL_MS
    })
    return { result: summary }
  }
}

export const desktopFocusWindow: ToolDefinition = {
  name: 'desktop_focus_window',
  description: 'Bring an application to the front. Required before synthetic clicks or typing, which go to whatever is focused.',
  capability: 'desktop.control',
  exclusiveDesktop: true,
  input: z.object({
    pid: z.number().int(),
    appName: z.string().describe('Used for the authorization check and the activity log'),
    windowId: z.string().optional()
  }),
  scopes: (i) => [{ kind: 'app', name: i.appName }],
  async execute(i, ctx) {
    await ctx.claimDesktop(`focusing ${i.appName}`)
    await ctx.os.focusWindow(i.pid, i.windowId)
    return { result: { pid: i.pid, focused: true } }
  },
  async verify(i, _o, ctx) {
    const apps = await ctx.os.listApps()
    const app = apps.find((a) => a.pid === i.pid)
    return {
      verified: !!app?.active,
      method: 'frontmost app check',
      detail: app?.active ? `${app.name} is frontmost` : `${i.appName} did not come to the front`
    }
  }
}

export const desktopPressElement: ToolDefinition = {
  name: 'desktop_press_element',
  description:
    'Perform an accessibility action on an element from desktop_inspect_window — the reliable way to press a button or pick a menu item. Fails cleanly if the window changed, which means you should re-inspect rather than retry.',
  capability: 'desktop.control',
  exclusiveDesktop: true,
  input: z.object({
    ref: z.string().describe('An element reference from desktop_inspect_window'),
    appName: z.string(),
    action: z.string().default('AXPress').describe('One of the actions listed on the element')
  }),
  scopes: (i) => [{ kind: 'app', name: i.appName }],
  async execute(i, ctx) {
    await ctx.claimDesktop(`pressing a control in ${i.appName}`)
    const ref = resolveRef(ctx, i.ref)
    await ctx.os.pressElement(ref, i.action)
    return { result: { ref: i.ref, action: i.action } }
  }
}

export const desktopSetValue: ToolDefinition = {
  name: 'desktop_set_value',
  description:
    'Set the text of a field directly through accessibility, without typing. Faster and more reliable than synthetic keystrokes. Reads the value back and fails if it did not take.',
  capability: 'desktop.control',
  exclusiveDesktop: true,
  input: z.object({
    ref: z.string(),
    appName: z.string(),
    value: z.string()
  }),
  scopes: (i) => [{ kind: 'app', name: i.appName }],
  async execute(i, ctx) {
    await ctx.claimDesktop(`filling a field in ${i.appName}`)
    const ref = resolveRef(ctx, i.ref)
    await ctx.os.setElementValue(ref, i.value)
    return { result: { ref: i.ref, value: i.value } }
  }
}

export const desktopClick: ToolDefinition = {
  name: 'desktop_click',
  description:
    'Click at a screen point. This is the fallback for when an element exposes no accessibility action — prefer desktop_press_element. Coordinates are in points with the origin at the top-left of the primary display.',
  capability: 'desktop.control',
  exclusiveDesktop: true,
  input: z.object({
    x: z.number(),
    y: z.number(),
    appName: z.string(),
    button: z.enum(['left', 'right']).default('left'),
    count: z.number().int().min(1).max(3).default(1),
    reason: z.string().describe('Why a raw click is needed instead of an accessibility action')
  }),
  scopes: (i) => [{ kind: 'app', name: i.appName }],
  async precondition(i, ctx) {
    const displays = await ctx.os.listDisplays()
    const onScreen = displays.some(
      (d) =>
        i.x >= d.bounds.x &&
        i.x <= d.bounds.x + d.bounds.width &&
        i.y >= d.bounds.y &&
        i.y <= d.bounds.y + d.bounds.height
    )
    if (!onScreen) throw new Error(`(${i.x}, ${i.y}) is not on any display`)
  },
  async execute(i, ctx) {
    await ctx.claimDesktop(`clicking in ${i.appName}`)
    ctx.log('info', `raw click at (${i.x}, ${i.y}): ${i.reason}`)
    await ctx.os.click({ x: i.x, y: i.y }, { button: i.button, count: i.count })
    return { result: { x: i.x, y: i.y }, uncertain: true }
  }
}

export const desktopType: ToolDefinition = {
  name: 'desktop_type',
  description: 'Type text into whatever is focused. Focus a field first. Prefer desktop_set_value when the field is reachable through accessibility.',
  capability: 'desktop.control',
  exclusiveDesktop: true,
  input: z.object({ text: z.string().min(1).max(5000), appName: z.string() }),
  scopes: (i) => [{ kind: 'app', name: i.appName }],
  async execute(i, ctx) {
    await ctx.claimDesktop(`typing in ${i.appName}`)
    await ctx.os.typeText(i.text)
    return { result: { typed: i.text.length }, uncertain: true }
  }
}

export const desktopShortcut: ToolDefinition = {
  name: 'desktop_shortcut',
  description: 'Send a keyboard shortcut to the focused app, e.g. "cmd+s" or "cmd+shift+n".',
  capability: 'desktop.control',
  exclusiveDesktop: true,
  input: z.object({
    keys: z.string().describe('Modifiers plus one key, joined by "+", e.g. "cmd+shift+n"'),
    appName: z.string()
  }),
  scopes: (i) => [{ kind: 'app', name: i.appName }],
  async execute(i, ctx) {
    await ctx.claimDesktop(`sending ${i.keys} to ${i.appName}`)
    await ctx.os.shortcut(i.keys)
    return { result: { keys: i.keys }, uncertain: true }
  }
}

export const desktopScroll: ToolDefinition = {
  name: 'desktop_scroll',
  description: 'Scroll at a screen point. Positive dy scrolls up, negative scrolls down.',
  capability: 'desktop.control',
  exclusiveDesktop: true,
  input: z.object({
    x: z.number(),
    y: z.number(),
    dx: z.number().int().default(0),
    dy: z.number().int().default(-120),
    appName: z.string()
  }),
  scopes: (i) => [{ kind: 'app', name: i.appName }],
  async execute(i, ctx) {
    await ctx.claimDesktop(`scrolling in ${i.appName}`)
    await ctx.os.scroll({ x: i.x, y: i.y }, i.dx, i.dy)
    return { result: { scrolled: true } }
  }
}

export const desktopCaptureWindow: ToolDefinition = {
  name: 'desktop_capture_window',
  description:
    'Take a picture of one application window. Use only when accessibility gives you nothing usable — it costs more and reveals screen contents to the vision model. Never use it to watch continuously.',
  capability: 'desktop.capture',
  input: z.object({ pid: z.number().int(), appName: z.string() }),
  scopes: (i) => [{ kind: 'app', name: i.appName }],
  async execute(i, ctx) {
    const shot = await ctx.os.captureWindow(i.pid)
    ctx.observe({
      kind: 'screen',
      summary: `Captured ${i.appName} (${shot.width}x${shot.height} @${shot.scaleFactor}x)`,
      data: { path: shot.path, scaleFactor: shot.scaleFactor },
      staleAfterMs: 15_000
    })
    return { result: shot }
  }
}

/**
 * One call that answers "what am I looking at".
 *
 * Composing this out of desktop_list_apps plus desktop_inspect_window cost a
 * round trip each and left the model deciding which window mattered. The
 * frontmost window is almost always the answer, so this returns it together
 * with what else is open, in one step.
 */
export const screenLook: ToolDefinition = {
  name: 'screen_look',
  description:
    'Look at what is on screen right now: the window in front, the controls inside it, and what else is open. Start here whenever the user refers to what they are doing, looking at, or "this". Reads the accessibility tree, not pixels, so it is fast and exact.',
  capability: 'desktop.observe',
  input: z.object({
    controls: z
      .boolean()
      .default(true)
      .describe('Include the controls of the frontmost window. Turn off for a bare list of what is open.')
  }),
  scopes: () => [],
  async execute(i, ctx) {
    const [apps, front] = await Promise.all([ctx.os.listApps(), ctx.os.getFrontmostWindow()])
    const others = apps
      .filter((a) => a.windowCount > 0 && a.pid !== front?.app.pid)
      .map((a) => ({ name: a.name, pid: a.pid, windows: a.windowCount }))

    if (!front) {
      ctx.observe({
        kind: 'screen',
        summary: `Nothing is frontmost; ${others.length} apps have windows open`,
        data: { others },
        staleAfterMs: SNAPSHOT_TTL_MS
      })
      return { result: { frontmost: null, alsoOpen: others } }
    }

    const summary = i.controls ? summarizeSnapshot(front, ctx.task.id) : null
    ctx.observe({
      kind: 'screen',
      summary: `In front: ${front.app.name} — "${front.title}"` + (summary ? ` (${summary.elements.length} controls)` : ''),
      data: { app: front.app.name, title: front.title, others: others.length },
      staleAfterMs: SNAPSHOT_TTL_MS
    })
    return {
      result: {
        frontmost: summary ?? {
          app: front.app.name,
          pid: front.app.pid,
          title: front.title,
          frame: front.frame
        },
        alsoOpen: others
      }
    }
  }
}

export const desktopTools: ToolDefinition[] = [
  screenLook,
  desktopListApps,
  desktopInspectWindow,
  desktopFocusWindow,
  desktopPressElement,
  desktopSetValue,
  desktopClick,
  desktopType,
  desktopShortcut,
  desktopScroll,
  desktopCaptureWindow
]
