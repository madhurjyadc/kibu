import { resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { Authorization } from '../shared/types.js'
import type { ScopeRequest } from './tools/registry.js'

/** Directories we never touch, whatever the model proposes. */
const FORBIDDEN_PREFIXES = [
  '/System',
  '/Library/LaunchDaemons',
  '/Library/LaunchAgents',
  '/usr/bin',
  '/usr/sbin',
  '/bin',
  '/sbin',
  '/private/var/db',
  resolve(homedir(), 'Library/Keychains'),
  resolve(homedir(), '.ssh'),
  resolve(homedir(), '.aws'),
  resolve(homedir(), '.gnupg')
]

export interface ScopeDecision {
  allowed: boolean
  /** Populated when `allowed` is false: what to ask the user to grant. */
  missing: ScopeRequest[]
  /** Set when the request must be refused outright rather than escalated. */
  refused?: string
}

export function normalizePath(p: string): string {
  const expanded = p.startsWith('~') ? resolve(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p
  return resolve(expanded)
}

/** True when `child` is `parent` or sits underneath it. */
export function isWithin(parent: string, child: string): boolean {
  const p = normalizePath(parent)
  const c = normalizePath(child)
  if (p === c) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

export function isForbidden(path: string): boolean {
  const p = normalizePath(path)
  return FORBIDDEN_PREFIXES.some((prefix) => isWithin(prefix, p))
}

/**
 * Decides whether the requested scopes fall inside the task's authorization.
 *
 * This is deliberately local, deterministic code. No model output — including
 * a confident Jev classification — can stand in for this check.
 */
export function checkScopes(auth: Authorization, requests: ScopeRequest[]): ScopeDecision {
  const missing: ScopeRequest[] = []

  for (const req of requests) {
    switch (req.kind) {
      case 'read':
      case 'write': {
        if (isForbidden(req.path)) {
          return {
            allowed: false,
            missing: [],
            refused: `${req.path} is in a protected system location Kibu will not modify.`
          }
        }
        // A write root implies the right to read the same tree.
        const roots = req.kind === 'read' ? [...auth.readRoots, ...auth.writeRoots] : auth.writeRoots
        if (!roots.some((root) => isWithin(root, req.path))) missing.push(req)
        break
      }
      case 'app': {
        const wanted = req.name.toLowerCase()
        if (!auth.apps.some((a) => a.toLowerCase() === wanted)) missing.push(req)
        break
      }
      case 'origin': {
        if (auth.origins.includes('*')) break
        let origin: string
        try {
          origin = new URL(req.url).origin
        } catch {
          return { allowed: false, missing: [], refused: `"${req.url}" is not a valid URL.` }
        }
        if (!auth.origins.includes(origin)) missing.push({ kind: 'origin', url: origin })
        break
      }
      case 'capability': {
        if (!auth.capabilities.includes(req.name)) missing.push(req)
        break
      }
    }
  }

  return { allowed: missing.length === 0, missing }
}

/** Folds a user-approved grant into the task's authorization. */
export function extendAuthorization(auth: Authorization, grant: Partial<Authorization>): Authorization {
  const merge = (a: string[], b: string[] | undefined): string[] => [...new Set([...a, ...(b ?? [])])]
  return {
    readRoots: merge(auth.readRoots, grant.readRoots?.map(normalizePath)),
    writeRoots: merge(auth.writeRoots, grant.writeRoots?.map(normalizePath)),
    apps: merge(auth.apps, grant.apps),
    origins: merge(auth.origins, grant.origins),
    capabilities: merge(auth.capabilities, grant.capabilities)
  }
}

/** Turns missing scopes into a sentence the user can act on. */
export function describeMissing(missing: ScopeRequest[]): string {
  const parts: string[] = []
  const paths = missing.filter((m) => m.kind === 'read' || m.kind === 'write') as Extract<
    ScopeRequest,
    { kind: 'read' | 'write' }
  >[]
  if (paths.length) {
    const verb = paths.some((p) => p.kind === 'write') ? 'change files in' : 'read'
    const unique = [...new Set(paths.map((p) => p.path))]
    parts.push(`${verb} ${unique.slice(0, 3).join(', ')}${unique.length > 3 ? ` and ${unique.length - 3} more` : ''}`)
  }
  for (const m of missing) {
    if (m.kind === 'app') parts.push(`control ${m.name}`)
    if (m.kind === 'origin') parts.push(`visit ${m.url}`)
    if (m.kind === 'capability') parts.push(`use ${m.name}`)
  }
  return parts.join(', ')
}

/** Converts missing scopes into the grant that would satisfy them. */
export function grantFor(missing: ScopeRequest[]): Partial<Authorization> {
  const grant: Partial<Authorization> = {
    readRoots: [],
    writeRoots: [],
    apps: [],
    origins: [],
    capabilities: []
  }
  for (const m of missing) {
    if (m.kind === 'read') grant.readRoots!.push(normalizePath(m.path))
    if (m.kind === 'write') grant.writeRoots!.push(normalizePath(m.path))
    if (m.kind === 'app') grant.apps!.push(m.name)
    if (m.kind === 'origin') grant.origins!.push(m.url)
    if (m.kind === 'capability') grant.capabilities!.push(m.name)
  }
  return grant
}
