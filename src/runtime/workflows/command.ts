import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join, isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import { choice } from '../model/jev.js'
import { vetCommand, RefusedCommand } from '../tools/shell.js'
import type { Evidence } from '../../shared/types.js'
import type { Workflow, WorkflowContext, WorkflowResult } from './types.js'

/**
 * "Make a folder called automaton in dev and open it in Zed."
 *
 * Read entirely in code. This is the shape where a planning model is worst
 * value for money: the sentence is simple, the actions are few, and the user
 * is standing there waiting — several seconds of planning to run one mkdir is
 * absurd. Local patterns produce the steps; the macOS index resolves which
 * folder and which application was meant; Jev is asked only when more than
 * one real candidate exists, choosing between things this code found.
 */

export type Step =
  | { kind: 'mkdir'; path: string; label: string }
  | { kind: 'open'; path: string; app?: string; label: string }
  | { kind: 'shell'; program: string; args: string[]; label: string }

export interface Plan {
  steps: Step[]
  /** A folder named in the sentence that could not be resolved locally. */
  unresolvedFolder?: string
  /** An application named in the sentence that could not be resolved. */
  unresolvedApp?: string
}

const MAKE_FOLDER =
  /\b(?:create|make|add|new)\s+(?:a\s+)?(?:new\s+)?(?:folder|directory|dir)\s+(?:called|named|with the name)?\s*["'`]?([\w .\-]+?)["'`]?(?:\s+(?:in|inside|under|within|at)\s+(?:the\s+)?["'`]?([\w /.\-~]+?)["'`]?(?:\s+folder)?)?\s*(?:,|\.|$|and\b)/i

const OPEN_IN = /\bopen\s+(?:it|that|this|them|["'`]?([\w /.\-~]+?)["'`]?)\s+(?:in|with|using)\s+(?:the\s+)?["'`]?([\w .\-]+?)["'`]?(?:\s+(?:editor|app|application))?\s*(?:,|\.|$|and\b)/i

const LITERAL = /^\s*(?:run|execute|exec)\s+["'`]?(.+?)["'`]?\s*$/i

export const commandWorkflow: Workflow = {
  id: 'run_command',
  description: 'Create folders, open things in a chosen application, or run one simple safe command.',
  routes: ['files', 'desktop', 'mixed', 'unclear'],

  plausible(request) {
    return MAKE_FOLDER.test(request) || OPEN_IN.test(request) || LITERAL.test(request)
  },

  async run(request, droppedPaths, ctx): Promise<WorkflowResult> {
    const plan = await buildPlan(request, droppedPaths, ctx)

    if (plan.steps.length === 0) {
      return {
        success: false,
        headline: 'I could not work out what to run.',
        evidence: [],
        handoffToPlanner: plan.unresolvedFolder
          ? `could not find a folder called "${plan.unresolvedFolder}"`
          : 'no command could be parsed from the request'
      }
    }

    const evidence: Evidence[] = []
    const done: string[] = []
    for (const step of plan.steps) {
      await ctx.checkpoint()
      ctx.progress(step.label)

      const res =
        step.kind === 'mkdir'
          ? await ctx.run('files_create_folder', { path: step.path })
          : step.kind === 'open'
            ? await ctx.run('app_open', { path: step.path, ...(step.app ? { app: step.app } : {}) })
            : await ctx.run('shell_run', { program: step.program, args: step.args })

      if (!res.ok) {
        return {
          success: false,
          headline: `${step.label} failed: ${res.error ?? 'unknown error'}`,
          evidence,
          unresolved: done.length ? `already done: ${done.join(', ')}` : undefined
        }
      }
      done.push(step.label)
      if (step.kind === 'mkdir') evidence.push({ kind: 'path', label: basename(step.path), value: step.path })
      if (step.kind === 'shell') {
        const out = ((res.result as { stdout?: string })?.stdout ?? '').trim()
        if (out) evidence.push({ kind: 'text', label: `${step.program} said`, value: out.slice(0, 600) })
      }
    }

    return { success: true, headline: done.join(', then ') + '.', evidence }
  }
}

/** Turns the sentence into steps. Exported so the parsing is directly testable. */
export async function buildPlan(
  request: string,
  droppedPaths: string[],
  ctx: Pick<WorkflowContext, 'ask' | 'log'>
): Promise<Plan> {
  const plan: Plan = { steps: [] }

  const literal = LITERAL.exec(request)
  if (literal) {
    const parts = splitArgs(literal[1]!)
    if (parts.length) {
      try {
        const vetted = vetCommand(parts[0]!, parts.slice(1))
        plan.steps.push({
          kind: 'shell',
          program: vetted.program,
          args: vetted.args,
          label: `ran ${vetted.program} ${vetted.args.join(' ')}`.trim()
        })
        return plan
      } catch (err) {
        if (err instanceof RefusedCommand) {
          ctx.log('warn', `refused: ${err.message}`)
          return plan
        }
        throw err
      }
    }
  }

  let created: string | null = null
  const make = MAKE_FOLDER.exec(request)
  if (make) {
    const name = make[1]!.trim()
    const where = make[2]?.trim()
    const parent = where ? await resolveFolder(where, ctx) : homedir()
    if (where && !parent) {
      plan.unresolvedFolder = where
      return plan
    }
    created = join(parent ?? homedir(), name)
    plan.steps.push({ kind: 'mkdir', path: created, label: `made ${name} in ${short(parent ?? homedir())}` })
  }

  const openIn = OPEN_IN.exec(request)
  if (openIn) {
    const what = openIn[1]?.trim()
    const appName = openIn[2]!.trim()
    // "open it in Zed" means the folder just created, or what was dropped.
    const target = what && !/^(it|that|this|them)$/i.test(what)
      ? ((await resolveFolder(what, ctx)) ?? (isAbsolute(what) ? what : null))
      : (created ?? droppedPaths[0] ?? null)
    if (!target) {
      plan.unresolvedFolder = what ?? 'the thing to open'
      return plan
    }
    const app = await resolveApp(appName, ctx)
    if (!app) {
      plan.unresolvedApp = appName
      return plan
    }
    plan.steps.push({ kind: 'open', path: target, app, label: `opened ${basename(target)} in ${app}` })
  }

  return plan
}

/**
 * Finds the folder the user meant.
 *
 * Tries the obvious literal places first, because "dev" almost always means
 * ~/dev and a hit there costs nothing. Only when several real candidates
 * exist does Jev pick between them — and it picks from paths this code found,
 * never a path it invented.
 */
async function resolveFolder(name: string, ctx: Pick<WorkflowContext, 'ask' | 'log'>): Promise<string | null> {
  const cleaned = name.replace(/^~\//, '').replace(/\/$/, '').trim()
  if (isAbsolute(name) && (await isDir(name))) return name
  if (cleaned.startsWith('~')) {
    const expanded = join(homedir(), cleaned.slice(1))
    if (await isDir(expanded)) return expanded
  }

  const direct = join(homedir(), cleaned)
  if (await isDir(direct)) return direct
  for (const common of ['Documents', 'Desktop', 'Downloads', 'Developer', 'Projects']) {
    const candidate = join(homedir(), common, cleaned)
    if (await isDir(candidate)) return candidate
  }

  const found = await findDirs(cleaned)
  if (found.length === 0) return null
  if (found.length === 1) return found[0]!

  const criteria: Record<string, string> = {}
  for (const [i, dir] of found.slice(0, 5).entries()) criteria[String(i)] = short(dir)
  const answers = await ctx.ask('which_folder', { folderName: cleaned, candidates: found.slice(0, 5) }, {
    folder: choice(`Which of these is the "${cleaned}" folder the user means?`, criteria)
  })
  const picked = answers?.folder.choice
  if (picked && found[Number(picked)]) return found[Number(picked)]!
  // No Jev, or an unusable answer: the shallowest path is the best guess.
  return found.sort((a, b) => a.split('/').length - b.split('/').length)[0]!
}

/** Matches an application name against what is actually installed. */
async function resolveApp(name: string, ctx: Pick<WorkflowContext, 'ask' | 'log'>): Promise<string | null> {
  const apps = await installedApps()
  const wanted = name.toLowerCase().replace(/\s+(editor|app|application)$/, '')
  const exact = apps.find((a) => a.toLowerCase() === wanted)
  if (exact) return exact
  const starts = apps.filter((a) => a.toLowerCase().startsWith(wanted))
  if (starts.length === 1) return starts[0]!
  const contains = apps.filter((a) => a.toLowerCase().includes(wanted))
  if (contains.length === 1) return contains[0]!
  const candidates = [...new Set([...starts, ...contains])].slice(0, 5)
  if (candidates.length === 0) return null

  const criteria: Record<string, string> = {}
  for (const [i, app] of candidates.entries()) criteria[String(i)] = app
  const answers = await ctx.ask('which_app', { appName: name, candidates }, {
    app: choice(`Which installed application does "${name}" mean?`, criteria)
  })
  const picked = answers?.app.choice
  return picked && candidates[Number(picked)] ? candidates[Number(picked)]! : candidates[0]!
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function findDirs(name: string): Promise<string[]> {
  return mdfind([
    '-onlyin',
    homedir(),
    `kMDItemContentType == "public.folder" && kMDItemFSName == "${name.replace(/"/g, '')}"cd`
  ]).then((paths) =>
    paths.filter((p) => !p.includes('/Library/') && !p.includes('/node_modules/') && !p.includes('/.')).slice(0, 8)
  )
}

let appCache: string[] | null = null
async function installedApps(): Promise<string[]> {
  if (appCache) return appCache
  const paths = await mdfind(['kMDItemContentType == "com.apple.application-bundle"'])
  appCache = [...new Set(paths.map((p) => basename(p).replace(/\.app$/, '')))]
  return appCache
}

function mdfind(args: string[]): Promise<string[]> {
  return new Promise((resolvePromise) => {
    execFile('/usr/bin/mdfind', args, { maxBuffer: 16 * 1024 * 1024, timeout: 8000 }, (err, stdout) => {
      resolvePromise(err && !stdout ? [] : String(stdout).split('\n').filter(Boolean))
    })
  })
}

/** Splits a dictated command into argv, honouring quotes but expanding nothing. */
export function splitArgs(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

function short(path: string): string {
  return path.replace(homedir(), '~')
}
