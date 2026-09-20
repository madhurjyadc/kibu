import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { HelperBridge } from './helper-bridge.js'
import type {
  AppInfo,
  CaptureResult,
  Capability,
  DisplayInfo,
  ElementRef,
  OsAdapter,
  WindowSnapshot
} from '../adapter.js'
import { StaleElementError } from '../adapter.js'
import type { OsPermission, PermissionStatus } from '../../shared/types.js'

const PERMISSION_PURPOSE: Record<OsPermission, string> = {
  accessibility:
    'Lets Kibu read window contents and press buttons in apps, instead of guessing from pixels.',
  'screen-recording':
    'Lets Kibu take a picture of a specific window when an app exposes no readable controls.',
  automation: 'Lets Kibu ask apps to perform scripted actions.',
  'full-disk': 'Lets Kibu reach folders macOS protects, such as Mail or Messages storage.'
}

export class MacOsAdapter implements OsAdapter {
  readonly platform = 'darwin' as const
  private bridge: HelperBridge

  constructor(helperPath: string) {
    this.bridge = new HelperBridge(helperPath)
  }

  supports(c: Capability): boolean {
    if (!this.bridge.available) return false
    const supported: Capability[] = [
      'apps.list',
      'window.inspect',
      'window.focus',
      'window.capture',
      'element.act',
      'input.synthetic',
      'display.info'
    ]
    return supported.includes(c)
  }

  async getPermissions(): Promise<PermissionStatus[]> {
    if (!this.bridge.available) {
      return (['accessibility', 'screen-recording'] as OsPermission[]).map((permission) => ({
        permission,
        granted: false,
        purpose: PERMISSION_PURPOSE[permission]
      }))
    }
    const raw = await this.bridge.call<{ accessibility: boolean; screenRecording: boolean }>('permissions')
    return [
      { permission: 'accessibility', granted: raw.accessibility, purpose: PERMISSION_PURPOSE.accessibility },
      {
        permission: 'screen-recording',
        granted: raw.screenRecording,
        purpose: PERMISSION_PURPOSE['screen-recording']
      }
    ]
  }

  async requestPermission(p: OsPermission): Promise<PermissionStatus> {
    const res = await this.bridge.call<{ granted: boolean }>('requestPermission', { permission: p }, 30_000)
    return { permission: p, granted: res.granted, purpose: PERMISSION_PURPOSE[p] }
  }

  listApps(): Promise<AppInfo[]> {
    return this.bridge.call<AppInfo[]>('listApps')
  }

  getFrontmostWindow(): Promise<WindowSnapshot | null> {
    return this.bridge.call<WindowSnapshot | null>('frontmostWindow', { maxDepth: 12, maxNodes: 400 })
  }

  async focusWindow(pid: number, windowId?: string): Promise<void> {
    await this.bridge.call('focusWindow', { pid, windowId })
  }

  inspectWindow(pid: number, opts: { maxDepth?: number; maxNodes?: number } = {}): Promise<WindowSnapshot> {
    return this.bridge.call<WindowSnapshot>('inspectWindow', {
      pid,
      maxDepth: opts.maxDepth ?? 12,
      maxNodes: opts.maxNodes ?? 400
    })
  }

  async pressElement(ref: ElementRef, action = 'AXPress'): Promise<void> {
    await this.withStaleCheck(() =>
      this.bridge.call('pressElement', {
        pid: ref.pid,
        windowId: ref.windowId,
        path: ref.path,
        stamp: ref.stamp,
        action
      })
    )
  }

  async setElementValue(ref: ElementRef, value: string): Promise<void> {
    const res = await this.withStaleCheck(() =>
      this.bridge.call<{ value: string; matches: boolean }>('setElementValue', {
        pid: ref.pid,
        windowId: ref.windowId,
        path: ref.path,
        stamp: ref.stamp,
        value
      })
    )
    if (!res.matches) {
      throw new Error(`value did not take effect: element now reads "${res.value}"`)
    }
  }

  async click(point: { x: number; y: number }, opts: { button?: 'left' | 'right'; count?: number } = {}): Promise<void> {
    await this.bridge.call('click', {
      x: point.x,
      y: point.y,
      button: opts.button ?? 'left',
      count: opts.count ?? 1
    })
  }

  async typeText(text: string): Promise<void> {
    // Long strings are slow to synthesise; the timeout scales with length.
    await this.bridge.call('type', { text }, Math.max(12_000, text.length * 40))
  }

  async shortcut(keys: string): Promise<void> {
    await this.bridge.call('shortcut', { keys })
  }

  async scroll(point: { x: number; y: number }, dx: number, dy: number): Promise<void> {
    await this.bridge.call('scroll', { x: point.x, y: point.y, dx, dy })
  }

  captureWindow(pid: number, windowId?: string): Promise<CaptureResult> {
    const outputPath = join(tmpdir(), `kibu-capture-${randomUUID()}.png`)
    return this.bridge.call<CaptureResult>('captureWindow', { pid, windowId, outputPath }, 20_000)
  }

  listDisplays(): Promise<DisplayInfo[]> {
    return this.bridge.call<DisplayInfo[]>('listDisplays')
  }

  async dispose(): Promise<void> {
    await this.bridge.dispose()
  }

  /** Turns the helper's "element changed" errors into a typed re-observe signal. */
  private async withStaleCheck<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/element changed|no longer (exists|resolves)|out of range/i.test(message)) {
        throw new StaleElementError(message)
      }
      throw err
    }
  }
}
