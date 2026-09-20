import { safeStorage } from 'electron'
import type { Store } from './db.js'

/**
 * Credential storage.
 *
 * Electron's safeStorage encrypts with a key held in the macOS Keychain, so
 * the ciphertext at rest is only decryptable by this app on this machine and
 * user. We never ship a shared provider key: the user supplies their own.
 */
const API_KEY = 'anthropic_api_key_encrypted'
const JEV_KEY = 'typesafe_api_key_encrypted'

export class Secrets {
  constructor(private readonly store: Store) {}

  get available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  private set(slot: string, key: string): boolean {
    const trimmed = key.trim()
    if (!trimmed) {
      this.store.setSetting(slot, '')
      return true
    }
    if (!this.available) return false
    this.store.setSetting(slot, safeStorage.encryptString(trimmed).toString('base64'))
    return true
  }

  private get(slot: string, envVar: string): string | null {
    const fallback = process.env[envVar] ?? null
    const stored = this.store.getSetting(slot)
    if (!stored || !this.available) return fallback
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      // A value encrypted under a different keychain entry cannot be read;
      // treat it as absent rather than crashing at startup.
      return fallback
    }
  }

  /** Anthropic, for the planning model. */
  setApiKey(key: string): boolean {
    return this.set(API_KEY, key)
  }
  getApiKey(): string | null {
    return this.get(API_KEY, 'ANTHROPIC_API_KEY')
  }
  hasApiKey(): boolean {
    return !!this.getApiKey()
  }

  /** TypeSafe AI, for Jev. A separate provider needs a separate credential. */
  setJevKey(key: string): boolean {
    return this.set(JEV_KEY, key)
  }
  getJevKey(): string | null {
    return this.get(JEV_KEY, 'TYPESAFE_API_KEY')
  }
  hasJevKey(): boolean {
    return !!this.getJevKey()
  }
}
