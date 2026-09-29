import { z } from 'zod'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { isForbidden, isWithin, normalizePath } from '../authorization.js'
import type { ScopeRequest, ToolDefinition } from './registry.js'

/**
 * Running things on the command line.
 *
 * The dangerous way to build this is to let a model write a shell string and
 * hand it to `sh -c`. Then one confused sentence, or one instruction hidden
 * in a web page, is arbitrary code execution. That does not happen here:
 *
 *  - There is no shell. Commands run through execFile with an argv array, so
 *    pipes, redirects, `;`, backticks and `$(...)` are inert text, not syntax.
 *  - Only the programs on ALLOWED can run, and the list holds nothing that
 *    deletes, escalates, or fetches-and-executes. `rm`, `sudo`, `curl` and
 *    friends are absent by design, not filtered out afterwards.
 *  - Every path argument, and the folder the command runs in, must resolve
 *    inside the user's home folder, never into a protected location, and
 *    inside what the task has been allowed to read or write.
 *  - Programs that run code (node, python3, npm) can do anything the user
 *    can, so no folder grant covers them: the user is shown the exact command
 *    and asked every single time.
 */

interface Allowed {
  /** Arguments that make this program change something on disk. */
  mutates: boolean
  /** Runs arbitrary code, so it is confirmed with the user every time. */
  runsCode?: boolean
  /** Refuse these arguments outright, whatever else the command says. */
  refuse?: RegExp
  /** When set, the first non-flag argument must be one of these subcommands. */
  subcommands?: Set<string>
}

/** Git subcommands that neither rewrite history, reach into config, nor run external programs. */
const GIT_SUBCOMMANDS = new Set([
  'init', 'status', 'log', 'diff', 'show', 'add', 'commit', 'branch', 'switch', 'stash', 'tag',
  'mv', 'blame', 'shortlog', 'rev-parse', 'remote', 'clone', 'fetch', 'pull', 'ls-files', 'grep'
])

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
  // Opening a script, an installer or an app bundle is running it; see vetOpen.
  open: { mutates: false, refuse: /^--args$/ },
  git: {
    mutates: true,
    subcommands: GIT_SUBCOMMANDS,
    // `-c`/`--config-env` set config for one run (aliases, core.sshCommand,
    // core.fsmonitor all execute programs); upload/receive-pack and ext::
    // URLs name a program for git to run.
    refuse: /^(-c|--config-env.*|--exec-path.*|--upload-pack.*|--receive-pack.*|-u|--exec.*|--template.*|ext::.*|fd::.*)$/
  },
  npm: { mutates: true, runsCode: true, refuse: /^(publish|unpublish|login|logout|adduser|token|owner|access|deprecate|dist-tag)$/ },
  node: { mutates: true, runsCode: true },
  python3: { mutates: true, runsCode: true },
  echo: { mutates: false },
  date: { mutates: false },
  whoami: { mutates: false }
}

/** Opening these is launching them. */
const LAUNCHES = /\.(app|command|tool|sh|zsh|bash|csh|pkg|mpkg|terminal|workflow|scpt|scptd|applescript|jar|webloc|inetloc|fileloc)\/?$/i

export class RefusedCommand extends Error {}

export interface ParsedCommand {
  program: string
  args: string[]
  mutates: boolean
  runsCode: boolean
  cwd: string
  /** Absolute paths the arguments name, in order. */
  paths: string[]
}

function looksLikePath(arg: string): boolean {
  return arg.includes('/') || isAbsolute(arg) || arg.startsWith('~')
}

function insideHome(full: string, shown: string): void {
  if (isForbidden(full)) throw new RefusedCommand(`${shown} is in a protected location.`)
  if (!isWithin(homedir(), full)) {
    throw new RefusedCommand(`${shown} is outside your home folder, so I will not touch it.`)
  }
}

/** True when a path is an app, a script, an installer, or any file marked executable. */
export function wouldLaunch(path: string): boolean {
  if (LAUNCHES.test(path)) return true
  try {
    const st = statSync(path)
    return st.isFile() && (st.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * Checks one command against the rules above.
 *
 * Exported because this is the security boundary, and a boundary that is not
 * directly tested is not a boundary.
 */
export function vetCommand(program: string, args: string[], cwd?: string): ParsedCommand {
  const name = basename(program)
  const rule = ALLOWED[name]
  if (!rule) {
    throw new RefusedCommand(
      `I can only run a short list of safe programs, and "${name}" is not one of them. ` +
        `Run it yourself if you meant it.`
    )
  }
  const dir = cwd ? normalizePath(cwd) : homedir()
  insideHome(dir, dir)

  if (rule.subcommands) {
    const sub = args.find((a) => !a.startsWith('-'))
    if (sub && !rule.subcommands.has(sub)) throw new RefusedCommand(`I will not run ${name} ${sub}.`)
  }

  const paths: string[] = []
  for (const arg of args) {
    if (rule.refuse?.test(arg)) {
      throw new RefusedCommand(`I will not run ${name} with "${arg}".`)
    }
    if (name === 'open' && /^[a-z][a-z0-9+.-]*:/i.test(arg) && !/^https?:\/\//i.test(arg)) {
      throw new RefusedCommand(`I only open files, folders and web pages, not "${arg}".`)
    }
    if (name === 'open' && /^https?:\/\//i.test(arg)) continue
    // An argument that looks like a path has to point somewhere allowed, even
    // when it is relative: `../../..` climbs out of the home folder too.
    if (looksLikePath(arg)) {
      const full = normalizePath(isAbsolute(arg) || arg.startsWith('~') ? arg : resolve(dir, arg))
      insideHome(full, arg)
      paths.push(full)
    }
  }
  if (name === 'open') {
    for (const arg of args) {
      if (arg.startsWith('-')) continue
      const full = looksLikePath(arg) ? normalizePath(isAbsolute(arg) || arg.startsWith('~') ? arg : resolve(dir, arg)) : resolve(dir, arg)
      if (wouldLaunch(full)) throw new RefusedCommand(`Opening ${basename(arg)} would run it, so I will not. Open it yourself if you trust it.`)
    }
  }
  return { program: name, args, mutates: rule.mutates, runsCode: !!rule.runsCode, cwd: dir, paths }
}

/**
 * What the task must be allowed before a command runs. Reading needs read
 * access to everything it names; changing needs write access to what it
 * changes. Bare names resolve in the working folder, so that folder counts too.
 */
export function commandScopes(vetted: ParsedCommand): ScopeRequest[] {
  const scopes: ScopeRequest[] = [{ kind: vetted.mutates && !vetted.paths.length ? 'write' : 'read', path: vetted.cwd }]
  if (vetted.runsCode) return [{ kind: 'write', path: vetted.cwd }]
  if (!vetted.mutates) return [...scopes, ...vetted.paths.map((path) => ({ kind: 'read' as const, path }))]
  if (vetted.program === 'cp') {
    // A copy reads its sources and writes only where it lands.
    const last = vetted.paths.length - 1
    return [...scopes, ...vetted.paths.map((path, i) => ({ kind: i === last ? ('write' as const) : ('read' as const), path }))]
  }
  return [...scopes, ...vetted.paths.map((path) => ({ kind: 'write' as const, path }))]
}

export const shellRun: ToolDefinition = {
  name: 'shell_run',
  description:
    'Run one command from a short allowlist of programs (mkdir, cp, mv, ls, cat, git, open and a few others; node, python3 and npm only with the user confirming each run). There is no shell: arguments are passed literally, so pipes, redirects and substitutions do not work. Anything destructive is refused.',
  capability: 'shell.run',
  input: z.object({
    program: z.string().describe('The program, e.g. "mkdir"'),
    args: z.array(z.string()).default([]).describe('Arguments, one per array entry — never a single joined string'),
    cwd: z.string().optional().describe('Directory to run in; defaults to your home folder')
  }),
  scopes: (i) => commandScopes(vetCommand(i.program, i.args, i.cwd)),
  confirm: (i) => {
    const vetted = vetCommand(i.program, i.args, i.cwd)
    return vetted.runsCode ? `run \`${[vetted.program, ...vetted.args].join(' ')}\` in ${vetted.cwd}, which can change anything your account can` : null
  },
  async execute(i, ctx) {
    const vetted = vetCommand(i.program, i.args, i.cwd)
    ctx.progress(`Running ${vetted.program} ${vetted.args.join(' ')}`)
    const { stdout, stderr, code } = await run(vetted.program, vetted.args, vetted.cwd)
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
    if (wouldLaunch(path)) throw new Error(`Opening ${basename(path)} would run it, so I will not. Open it yourself if you trust it.`)
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
