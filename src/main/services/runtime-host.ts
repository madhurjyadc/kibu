import { fork, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { HostToRuntime, RuntimeToHost } from '../../shared/protocol.js'

export interface RuntimeHostOptions {
  /** Absolute path to the built runtime entry point. */
  entry: string
  helperPath: string
  browserProfileDir: string
  downloadDir: string
  jevEnabled: boolean
}

/**
 * Owns the agent runtime child process.
 *
 * Keeping the runtime out-of-process is what lets the interface stay
 * responsive when a model call or a native operation stalls: the UI thread
 * never blocks on either, and a wedged runtime can be killed and restarted
 * without taking the app down.
 */
export class RuntimeHost extends EventEmitter {
  private child: ChildProcess | null = null
  private ready = false
  private stopping: Promise<void> | null = null
  private expectedExits = new WeakSet<ChildProcess>()

  constructor(private readonly options: RuntimeHostOptions) {
    super()
  }

  start(): void {
    if (this.child || this.stopping) return
    const child = fork(this.options.entry, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        KIBU_HELPER_PATH: this.options.helperPath,
        KIBU_BROWSER_PROFILE: this.options.browserProfileDir,
        KIBU_DOWNLOAD_DIR: this.options.downloadDir,
        KIBU_JEV: this.options.jevEnabled ? '1' : '0',
        // node:sqlite is not used here, but the runtime logs cleanly either way.
        NODE_NO_WARNINGS: '1'
      }
    })
    this.child = child

    child.on('message', (msg: RuntimeToHost) => {
      if (this.child !== child) return
      if (msg.type === 'ready') {
        this.ready = true
        this.emit('ready')
        return
      }
      this.emit('message', msg)
    })

    child.stdout?.on('data', (d: Buffer) => this.emit('stdout', d.toString()))
    child.stderr?.on('data', (d: Buffer) => this.emit('stderr', d.toString()))

    // A spawn failure arrives here, not as an exit. Without this listener Node
    // would throw an unhandled 'error' event and take the app down.
    child.on('error', (err) => {
      this.ready = false
      this.emit('spawn-error', err)
    })

    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.ready = false
        this.child = null
      }
      this.emit('exit', { code, signal, expected: this.expectedExits.has(child) })
    })
  }

  get isReady(): boolean {
    return this.ready
  }

  /** Start only when needed, and wait for IPC before accepting the first task. */
  async ensureReady(): Promise<void> {
    if (this.stopping) await this.stopping
    if (this.ready) return
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        this.off('ready', onReady)
        this.off('spawn-error', onError)
        this.off('exit', onExit)
      }
      const onReady = (): void => { cleanup(); resolve() }
      const onError = (err: Error): void => { cleanup(); reject(err) }
      const onExit = (): void => onError(new Error('The task runtime exited before it was ready.'))
      const timer = setTimeout(() => onError(new Error('The task runtime took too long to start.')), 15_000)
      this.once('ready', onReady)
      this.once('spawn-error', onError)
      this.once('exit', onExit)
      try { this.start() } catch (err) { onError(err instanceof Error ? err : new Error(String(err))) }
    })
  }

  send(msg: HostToRuntime): boolean {
    if (!this.child || !this.ready) return false
    return this.child.send(msg)
  }

  /** Kills and respawns. Used after a runtime crash. */
  restart(): void {
    void this.stop().then(() => this.start())
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    if (!this.child) return Promise.resolve()
    const child = this.child
    this.expectedExits.add(child)
    this.stopping = new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        child.off('exit', finish)
        child.off('close', finish)
        if (this.child === child) { this.child = null; this.ready = false }
        resolve()
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, 3000)
      child.once('exit', finish)
      child.once('close', finish)
      if (!this.ready || !this.send({ type: 'shutdown' })) child.kill('SIGKILL')
    }).finally(() => { this.stopping = null })
    return this.stopping
  }
}
