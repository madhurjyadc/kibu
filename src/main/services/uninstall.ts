import { basename, dirname, isAbsolute } from 'node:path'

/** Derive only the running app's bundle, never a renderer-supplied path. */
export function installedAppBundle(executable: string, packaged: boolean): string | null {
  if (!packaged || !isAbsolute(executable)) return null
  const macos = dirname(executable)
  const contents = dirname(macos)
  const bundle = dirname(contents)
  if (basename(macos) !== 'MacOS' || basename(contents) !== 'Contents' || !bundle.endsWith('.app') || basename(bundle) === '.app') return null
  return bundle
}

export interface UninstallDeps {
  executable(): string
  packaged(): boolean
  confirm(): Promise<boolean>
  loginEnabled(): boolean
  setLoginEnabled(value: boolean): void
  stopWork(): Promise<void>
  trash(bundle: string): Promise<void>
  quit(): void
}

export class AppUninstaller {
  inProgress = false
  constructor(private readonly deps: UninstallDeps) {}

  get available(): boolean {
    return installedAppBundle(this.deps.executable(), this.deps.packaged()) !== null
  }

  /** Use macOS Trash so removing the app remains recoverable. Keep user data. */
  async uninstall(): Promise<boolean> {
    if (this.inProgress) throw new Error('Kibu is already being uninstalled.')
    const bundle = installedAppBundle(this.deps.executable(), this.deps.packaged())
    if (!bundle) throw new Error('Uninstall is available in the installed Kibu app.')
    this.inProgress = true
    try {
      if (!await this.deps.confirm()) return false
      const openedAtLogin = this.deps.loginEnabled()
      this.deps.setLoginEnabled(false)
      try {
        await this.deps.stopWork()
        await this.deps.trash(bundle)
      } catch (err) {
        this.deps.setLoginEnabled(openedAtLogin)
        throw err
      }
      this.deps.quit()
      return true
    } finally { this.inProgress = false }
  }
}
