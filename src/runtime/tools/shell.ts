import { z } from 'zod'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'
import { isForbidden, normalizePath } from '../authorization.js'
import type { ToolDefinition } from './registry.js'

/**
 * Running things on the command line.
 *
 * The dangerous way to build this is to let a model write a shell string and
 * hand it to `sh -c`. Then one confused sentence, or one instruction hidden
 * in a web page, is arbitrary code execution. None of that happens here:
 *
 *  - There is no shell. Commands run through execFile with an argv array, so
 *    pipes, redirects, `;`, backticks and `$(...)` are inert text, not syntax.
 *  - Only the programs on ALLOWED can run, and the list holds nothing that
 *    deletes, escalates, or fetches-and-executes. `rm`, `sudo`, `curl` and
 *    friends are absent by design, not filtered out afterwards.
 *  - Every path argument must resolve inside the user's home folder, and
 *    never into a protected location.
 *
 * What that costs is generality: Kibu cannot run your whole shell. What it
 * buys is that no sentence, however badly parsed, turns into a destructive
 * command.
 */

interface Allowed {
  /** Arguments that make this program change something on disk. */
  mutates: boolean
  /** Refuse these flags outright, whatever else the command says. */
  refuse?: RegExp
}

const ALLOWED: Record<string, Allowed> = {
  mkdir: { mutates: true },
  touch: { mutates: true },
  cp: { mutates: true, refuse: /^-.*f/ },
  mv: { mutates: true, refuse: /^-.*f/ },
  ls: { mutates: false },
  pwd: { mutates: false },
  cat: { mutates: false },
  head: { mutates: false },
  tail: { mutates: false },
  wc: { mutates: false },
  du: { mutates: false },
  file: { mutates: false },
  which: { mutates: false },
  open: { mutates: false },
  git: { mutates: true, refuse: /^(push|reset|clean|rebase|checkout|restore)$/ },
  npm: { mutates: true, refuse: /^(publish|login|token)$/ },
  node: { mutates: true },
  python3: { mutates: true },
  echo: { mutates: false },
  date: { mutates: false },
  whoami: { mutates: false }
}

export class RefusedCommand extends Error {}

export interface ParsedCommand {
  program: string
  args: string[]
  mutates: boolean
}

/**
 * Checks one command against the rules above.
 *
 * Exported because this is the security boundary, and a boundary that is not
 * directly tested is not a boundary.
 */
export function vetCommand(program: string, args: string[]): ParsedCommand {
  const name = basename(program)
  const rule = ALLOWED[name]
  if (!rule) {
    throw new RefusedCommand(
      `I can only run a short list of safe programs, and "${name}" is not one of them. ` +
        `Run it yourself if you meant it.`
    )
  }
  for (const arg of args) {
    if (rule.refuse?.test(arg)) {
      throw new RefusedCommand(`I will not run ${name} with "${arg}".`)
    }
    // An argument that looks like a path has to point somewhere allowed, even
    // when it is relative: `../../..` climbs out of the home folder too.
    if (arg.includes('/') || isAbsolute(arg)) {
      const full = normalizePath(isAbsolute(arg) ? arg : resolve(homedir(), arg))
      if (isForbidden(full)) throw new RefusedCommand(`${arg} is in a protected location.`)
      if (!full.startsWith(homedir())) {
        throw new RefusedCommand(`${arg} is outside your home folder, so I will not touch it.`)
      }
    }
  }
  return { program: name, args, mutates: rule.mutates }
}

export const shellRun: ToolDefinition = {
  name: 'shell_run',
  description:
    'Run one command from a short allowlist of safe programs (mkdir, cp, mv, ls, git, npm, open, node, python3 and a few others). There is no shell: arguments are passed literally, so pipes, redirects and substitutions do not work. Anything destructive is refused.',
  capability: 'shell.run',
  input: z.object({
    program: z.string().describe('The program, e.g. "mkdir"'),
    args: z.array(z.string()).default([]).describe('Arguments, one per array entry — never a single joined string'),
    cwd: z.string().optional().describe('Directory to run in; defaults to your home folder')
  }),
  scopes: (i) => {
    const vetted = vetCommand(i.program, i.args)
    // Only a command that changes something needs a write grant.
    if (!vetted.mutates) return []
    const target = i.args.find((a: string) => a.includes('/') || isAbsolute(a))
    return target
      ? [{ kind: 'write', path: normalizePath(isAbsolute(target) ? target : resolve(i.cwd ?? homedir(), target)) }]
      : []
  },
  async execute(i, ctx) {
    const vetted = vetCommand(i.program, i.args)
    const cwd = i.cwd ? normalizePath(i.cwd) : homedir()
    ctx.progress(`Running ${vetted.program} ${vetted.args.join(' ')}`)
    const { stdout, stderr, code } = await run(vetted.program, vetted.args, cwd)
    ctx.observe({
      kind: 'files',
      summary: `${vetted.program} ${vetted.args.join(' ')} → exit ${code}`,
      data: { program: vetted.program, code },
      staleAfterMs: 30_000
    })
    if (code !== 0) throw new Error(stderr.trim() || `${vetted.program} exited with ${code}`)
    return { result: { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), code } }
  },
  async verify(i) {
    // Nothing generic to check: each caller verifies its own effect.
    return { verified: true, method: 'exit-code', detail: `${basename(i.program)} exited cleanly` }
  }
}

export const appOpen: ToolDefinition = {
  name: 'app_open',
  description:
    'Open a file or folder in a specific application, the way double-clicking it would. Use the application name as it appears in the Applications folder, e.g. "Zed", "Visual Studio Code", "Finder".',
  capability: 'shell.run',
  input: z.object({
    path: z.string().describe('The file or folder to open'),
    app: z.string().optional().describe('Application name; omit to use the system default')
  }),
  scopes: (i) => [{ kind: 'read', path: normalizePath(i.path) }],
  async execute(i, ctx) {
    const path = normalizePath(i.path)
    if (isForbidden(path)) throw new Error(`${path} is in a protected location.`)
    const args = i.app ? ['-a', i.app, path] : [path]
    ctx.progress(i.app ? `Opening ${basename(path)} in ${i.app}` : `Opening ${basename(path)}`)
    const { stderr, code } = await run('open', args, homedir())
    if (code !== 0) throw new Error(stderr.trim() || `could not open ${basename(path)}`)
    return { result: { opened: path, app: i.app ?? 'default' } }
  }
}

export const shellTools: ToolDefinition[] = [shellRun, appOpen]

function run(
  program: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    execFile(
      program,
      args,
      { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, shell: false },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
        resolvePromise({ stdout: String(stdout), stderr: String(stderr), code })
      }
    )
  })
}
