import type { KibuBridge } from '../../shared/protocol.js'

declare global {
  interface Window {
    kibu: KibuBridge & { getPathForFile(file: File): string }
  }
}

export {}
