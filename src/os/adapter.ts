/**
 * Capability-based OS adapter.
 *
 * The agent runtime never talks to macOS directly. It asks for capabilities,
 * and an adapter either provides them or reports them unsupported, so adding
 * Windows/Linux is a matter of writing another adapter, not touching the loop.
 */
import type { OsPermission, PermissionStatus } from '../shared/types.js'

export type Capability =
  | 'apps.list'
  | 'window.inspect'
  | 'window.focus'
  | 'window.capture'
  | 'element.act'
  | 'input.synthetic'
  | 'display.info'

export interface AppInfo {
  bundleId: string
  name: string
  pid: number
  active: boolean
  windowCount: number
}

export interface DisplayInfo {
  id: number
  /** Logical (point) bounds. */
  bounds: { x: number; y: number; width: number; height: number }
  /** Backing scale factor: 2 on Retina. All synthetic input uses points. */
  scaleFactor: number
  primary: boolean
}

/**
 * A reference to a UI element, valid only for the observation that produced it.
 * `stamp` lets the adapter confirm the element still matches before acting;
 * a mismatch means the window changed and the caller must re-observe.
 */
export interface ElementRef {
  id: string
  pid: number
  windowId: string
  /** Index path through the accessibility tree. */
  path: number[]
  stamp: ElementStamp
}

export interface ElementStamp {
  role: string
  title: string
  /** Logical-point frame at observation time. */
  frame: { x: number; y: number; width: number; height: number }
}

export interface UiElement {
  ref: ElementRef
  role: string
  subrole?: string
  title: string
  value?: string
  enabled: boolean
  focused: boolean
  frame: { x: number; y: number; width: number; height: number }
  /** Accessibility actions this element genuinely supports. */
  actions: string[]
  children?: UiElement[]
}

export interface WindowSnapshot {
  app: AppInfo
  windowId: string
  title: string
  frame: { x: number; y: number; width: number; height: number }
  displayId: number
  elements: UiElement[]
  observedAt: number
}

export interface CaptureResult {
  /** Absolute path to a PNG in the session's temp dir. */
  path: string
  width: number
  height: number
  scaleFactor: number
}

export class UnsupportedCapabilityError extends Error {
  constructor(public capability: Capability) {
    super(`Capability not supported on this platform: ${capability}`)
    this.name = 'UnsupportedCapabilityError'
  }
}

export class StaleElementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleElementError'
  }
}

export interface OsAdapter {
  readonly platform: 'darwin' | 'win32' | 'linux'
  supports(c: Capability): boolean

  /** OS permission grants. Checking must never itself trigger a prompt. */
  getPermissions(): Promise<PermissionStatus[]>
  /** Triggers the system prompt, or opens the relevant Settings pane. */
  requestPermission(p: OsPermission): Promise<PermissionStatus>

  listApps(): Promise<AppInfo[]>
  getFrontmostWindow(): Promise<WindowSnapshot | null>
  focusWindow(pid: number, windowId?: string): Promise<void>
  inspectWindow(pid: number, opts?: { maxDepth?: number; maxNodes?: number }): Promise<WindowSnapshot>

  pressElement(ref: ElementRef, action?: string): Promise<void>
  setElementValue(ref: ElementRef, value: string): Promise<void>

  click(point: { x: number; y: number }, opts?: { button?: 'left' | 'right'; count?: number }): Promise<void>
  typeText(text: string): Promise<void>
  shortcut(keys: string): Promise<void>
  scroll(point: { x: number; y: number }, dx: number, dy: number): Promise<void>

  captureWindow(pid: number, windowId?: string): Promise<CaptureResult>
  listDisplays(): Promise<DisplayInfo[]>

  dispose(): Promise<void>
}
