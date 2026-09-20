import { homedir } from 'node:os'
import { join } from 'node:path'
import { choice, noul } from '../model/jev.js'
import { TYPE_FAMILIES, type FileEntry } from './common.js'
import type { Workflow, WorkflowContext, WorkflowResult } from './types.js'

/**
 * "Find the PDF I downloaded yesterday and open it."
 *
 * This is the shape Jev is best at: turning an unstructured sentence into a
 * few structured filters chosen from fixed sets. The search itself, the
 * ranking and the opening are ordinary deterministic code.
 */

const DAY = 24 * 60 * 60 * 1000

const TIMEFRAMES: Record<string, { description: string; sinceMs: number | null }> = {
  today: { description: 'Today only.', sinceMs: DAY },
  yesterday: { description: 'Yesterday, or the last couple of days.', sinceMs: 2 * DAY },
  this_week: { description: 'Within roughly the last week.', sinceMs: 7 * DAY },
  this_month: { description: 'Within roughly the last month.', sinceMs: 31 * DAY },
  any: { description: 'No particular time was mentioned.', sinceMs: null }
}

const LOCATIONS: Record<string, { description: string; dir: string }> = {
  downloads: { description: 'The Downloads folder.', dir: join(homedir(), 'Downloads') },
  desktop: { description: 'The Desktop.', dir: join(homedir(), 'Desktop') },
  documents: { description: 'The Documents folder.', dir: join(homedir(), 'Documents') }
}

export const findWorkflow: Workflow = {
  id: 'find_files',
  description: 'Find a file the user is describing from memory and open or reveal it.',

  plausible(request) {
    return /\b(find|locate|where is|search for|open the|show me|dig up)\b/i.test(request)
  },

  async run(request, droppedPaths, ctx): Promise<WorkflowResult> {
    ctx.progress('Working out what to look for')

    const typeCriteria: Record<string, string> = { any: 'No particular kind of file was mentioned.' }
    for (const f of TYPE_FAMILIES) typeCriteria[f.group] = f.description

    const answers = await ctx.ask(
      'find_filters',
      { userRequest: request, today: new Date().toDateString() },
      {
        fileType: choice('What kind of file is the user looking for?', typeCriteria),
        timeframe: choice(
          'When was the file last saved or downloaded?',
          Object.fromEntries(Object.entries(TIMEFRAMES).map(([k, v]) => [k, v.description]))
        ),
        location: choice('Where would the file most likely be?', {
          ...Object.fromEntries(Object.entries(LOCATIONS).map(([k, v]) => [k, v.description])),
          anywhere: 'No particular place; search the folders this task can already reach.'
        }),
        shouldOpen: noul('Does the user want the file opened, rather than just told where it is?')
      }
    )

    // Without Jev, fall back to keyword rules over the same option sets.
    const filters = answers
      ? {
          fileType: answers.fileType.choice,
          timeframe: answers.timeframe.choice,
          location: answers.location.choice,
          shouldOpen: answers.shouldOpen.noul > 0.5
        }
      : localFilters(request)

    const roots = filters.location === 'anywhere'
      ? ctx.authorizedRoots()
      : [LOCATIONS[filters.location]?.dir ?? ctx.authorizedRoots()[0] ?? join(homedir(), 'Downloads')]
    if (roots.length === 0) {
      return {
        success: false,
        headline: 'I need a folder to search in.',
        evidence: [],
        handoffToPlanner: 'no searchable folder is authorized'
      }
    }

    const extensions = filters.fileType === 'any'
      ? undefined
      : TYPE_FAMILIES.find((f) => f.group === filters.fileType)?.exts
    const since = TIMEFRAMES[filters.timeframe]?.sinceMs
    const modifiedAfter = since ? Date.now() - since : undefined

    ctx.progress(`Searching ${roots[0]!.split('/').pop()}`)
    const matches: FileEntry[] = []
    for (const root of roots.slice(0, 3)) {
      await ctx.checkpoint()
      const res = await ctx.run('files_search', {
        root,
        ...(extensions ? { extensions } : {}),
        ...(modifiedAfter ? { modifiedAfter } : {}),
        maxDepth: 3,
        limit: 50
      })
      if (res.ok) matches.push(...(res.result as { matches: FileEntry[] }).matches)
    }

    if (matches.length === 0) {
      return {
        success: false,
        headline: `I could not find a ${filters.fileType === 'any' ? 'file' : filters.fileType.toLowerCase().replace(/s$/, '')} matching that.`,
        evidence: [],
        unresolved: `searched ${roots.join(', ')}`
      }
    }

    // Most recent first; for a "the file I just downloaded" request that is
    // almost always the right answer.
    matches.sort((a, b) => b.modifiedAt - a.modifiedAt)
    const best = matches[0]!

    // More than one plausible hit: let the user choose rather than guess.
    if (matches.length > 1 && droppedPaths.length === 0) {
      const options = matches.slice(0, 5).map((m, i) => ({
        id: String(i),
        label: m.name,
        detail: new Date(m.modifiedAt).toLocaleString()
      }))
      const answer = await ctx.askUser({
        reason: 'ambiguous',
        prompt: `I found ${matches.length} files that fit. Which one did you mean?`,
        allowFreeText: false,
        options: [...options, { id: 'none', label: 'None of these' }]
      })
      if (answer.optionId === 'none' || answer.optionId === null) {
        return { success: false, headline: 'No matching file chosen.', evidence: [], unresolved: 'user rejected the matches' }
      }
      const chosen = matches[Number(answer.optionId)] ?? best
      return finish(chosen, filters.shouldOpen, ctx)
    }

    return finish(best, filters.shouldOpen, ctx)
  }
}

async function finish(file: FileEntry, shouldOpen: boolean, ctx: WorkflowContext): Promise<WorkflowResult> {
  // Opening is left to the user via the evidence buttons rather than done
  // automatically: launching an application is not something to do silently.
  ctx.log('info', `found ${file.path}`, { shouldOpen })
  return {
    success: true,
    headline: shouldOpen
      ? `Found ${file.name}. Open it below.`
      : `Found ${file.name}, last changed ${new Date(file.modifiedAt).toLocaleString()}.`,
    evidence: [{ kind: 'path', label: file.name, value: file.path }]
  }
}

/** Keyword fallback over the same fixed option sets Jev chooses from. */
function localFilters(request: string): {
  fileType: string
  timeframe: string
  location: string
  shouldOpen: boolean
} {
  const r = request.toLowerCase()
  const family = TYPE_FAMILIES.find((f) => f.exts.some((e) => r.includes(e.slice(1))) || r.includes(f.group.toLowerCase()))
  const timeframe = /\btoday\b/.test(r)
    ? 'today'
    : /\byesterday\b/.test(r)
      ? 'yesterday'
      : /\b(this week|last week|few days)\b/.test(r)
        ? 'this_week'
        : /\b(this month|last month)\b/.test(r)
          ? 'this_month'
          : 'any'
  const location = /\bdesktop\b/.test(r) ? 'desktop' : /\bdocuments?\b/.test(r) ? 'documents' : 'downloads'
  return {
    fileType: family?.group ?? 'any',
    timeframe,
    location,
    shouldOpen: /\bopen\b/.test(r)
  }
}
