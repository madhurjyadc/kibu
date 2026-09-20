import { MacOsAdapter } from './macos/index.js'
import type { Capability, OsAdapter } from './adapter.js'
import { UnsupportedCapabilityError } from './adapter.js'
import type { OsPermission, PermissionStatus } from '../shared/types.js'

/**
 * A do-nothing adapter for platforms we have not implemented yet. It reports
 * every capability as unsupported rather than pretending, so the runtime
 * degrades to file operations instead of failing in confusing ways.
 */
class UnimplementedAdapter implements OsAdapter {
  constructor(readonly platform: 'win32' | 'linux') {}
  supports(_c: Capability): boolean {
    return false
  }
  async getPermissions(): Promise<PermissionStatus[]> {
    return []
  }
  async requestPermission(p: OsPermission): Promise<PermissionStatus> {
    return { permission: p, granted: false, purpose: 'Not implemented on this platform yet.' }
  }
  private fail(c: Capability): never {
    throw new UnsupportedCapabilityError(c)
  }
  async listApps(): Promise<never> { this.fail('apps.list') }
  async getFrontmostWindow(): Promise<never> { this.fail('window.inspect') }
  async focusWindow(): Promise<never> { this.fail('window.focus') }
  async inspectWindow(): Promise<never> { this.fail('window.inspect') }
  async pressElement(): Promise<never> { this.fail('element.act') }
  async setElementValue(): Promise<never> { this.fail('element.act') }
  async click(): Promise<never> { this.fail('input.synthetic') }
  async typeText(): Promise<never> { this.fail('input.synthetic') }
  async shortcut(): Promise<never> { this.fail('input.synthetic') }
  async scroll(): Promise<never> { this.fail('input.synthetic') }
  async captureWindow(): Promise<never> { this.fail('window.capture') }
  async listDisplays(): Promise<never> { this.fail('display.info') }
  async dispose(): Promise<void> {}
}

export function createOsAdapter(helperPath: string): OsAdapter {
  if (process.platform === 'darwin') return new MacOsAdapter(helperPath)
  return new UnimplementedAdapter(process.platform === 'win32' ? 'win32' : 'linux')
}

export * from './adapter.js'
