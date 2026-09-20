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

  constructor(private readonly options: RuntimeHostOptions) {
    super()
  }

  start(): void {
    if (this.child) return
    this.child = fork(this.options.entry, [], {
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

    this.child.on('message', (msg: RuntimeToHost) => {
      if (msg.type === 'ready') {
        this.ready = true
        this.emit('ready')
        return
      }
      this.emit('message', msg)
    })

    this.child.stdout?.on('data', (d: Buffer) => this.emit('stdout', d.toString()))
    this.child.stderr?.on('data', (d: Buffer) => this.emit('stderr', d.toString()))

    // A spawn failure arrives here, not as an exit. Without this listener Node
    // would throw an unhandled 'error' event and take the app down.
    this.child.on('error', (err) => {
      this.ready = false
      this.emit('spawn-error', err)
    })

    this.child.on('exit', (code, signal) => {
      this.ready = false
      this.child = null
      this.emit('exit', { code, signal })
    })
  }

  get isReady(): boolean {
    return this.ready
  }

  send(msg: HostToRuntime): boolean {
    if (!this.child || !this.ready) return false
    return this.child.send(msg)
  }

  /** Kills and respawns. Used after a runtime crash. */
  restart(): void {
    this.child?.kill('SIGKILL')
    this.child = null
    this.ready = false
    this.start()
  }

  async stop(): Promise<void> {
    if (!this.child) return
    this.send({ type: 'shutdown' })
    const child = this.child
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.child = null
    this.ready = false
  }
}
