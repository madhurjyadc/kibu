import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'

export interface HelperResponse {
  id: string
  ok: boolean
  value?: unknown
  error?: string
}

/**
 * Owns the long-lived kibu-helper process and turns its line protocol into
 * promises. Every call is bounded by a timeout so a wedged helper can never
 * stall the runtime or the UI.
 */
export class HelperBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private buffer = ''
  private seq = 0
  private starting: Promise<void> | null = null

  constructor(private readonly binaryPath: string) {
    super()
  }

  get available(): boolean {
    return existsSync(this.binaryPath)
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return
    if (this.starting) return this.starting
    this.starting = new Promise<void>((resolve, reject) => {
      if (!this.available) {
        reject(new Error(`macOS helper not found at ${this.binaryPath}. Run "npm run helper:build".`))
        return
      }
      const child = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.onData(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => this.emit('stderr', chunk))

      child.on('exit', (code, signal) => {
        const err = new Error(`macOS helper exited (code=${code} signal=${signal})`)
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(err)
        }
        this.pending.clear()
        this.child = null
        this.starting = null
        this.emit('exit', code)
      })
      child.on('error', reject)
      resolve()
    })
    return this.starting
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let msg: HelperResponse
      try {
        msg = JSON.parse(line) as HelperResponse
      } catch {
        this.emit('stderr', `unparseable helper line: ${line}`)
        continue
      }
      const pending = this.pending.get(msg.id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(msg.id)
      if (msg.ok) pending.resolve(msg.value)
      else pending.reject(new Error(msg.error ?? 'helper reported failure without a reason'))
    }
  }

  async call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 12_000): Promise<T> {
    await this.ensureStarted()
    const child = this.child
    if (!child) throw new Error('macOS helper is not running')
    const id = `r${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`macOS helper timed out after ${timeoutMs}ms on "${op}"`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`)
    })
  }

  async dispose(): Promise<void> {
    if (!this.child) return
    try {
      await this.call('shutdown', {}, 2000)
    } catch {
      this.child?.kill('SIGTERM')
    }
    this.child = null
  }
}
