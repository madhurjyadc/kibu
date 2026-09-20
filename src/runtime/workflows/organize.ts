import { join } from 'node:path'
import { choice, noul } from '../model/jev.js'
import {
  candidateDateGroups,
  candidateProjectGroups,
  dateGroupFor,
  isYes,
  listFolder,
  typeGroupFor,
  TYPE_FAMILIES,
  type FileEntry
} from './common.js'
import type { Workflow, WorkflowContext, WorkflowResult } from './types.js'

/**
 * "Organise this folder."
 *
 * Local code enumerates every candidate grouping — by file type, by a project
 * name that recurs across filenames, or by month. Jev picks which of those
 * fits, then assigns each file to one of the resulting folders. Nothing is
 * invented by a model: every folder name comes from the files themselves or
 * from the fixed type table.
 */
export const organizeWorkflow: Workflow = {
  id: 'organize_folder',
  description: 'Tidy a folder by moving its files into subfolders, grouped by type, project or date.',
  routes: ['files'],

  plausible(request, droppedPaths) {
    if (droppedPaths.length > 0) return true
    return /\b(organi[sz]e|tidy|sort|clean ?up|group|arrange|declutter)\b/i.test(request)
  },

  async run(request, droppedPaths, ctx): Promise<WorkflowResult> {
    const target = pickTargetFolder(droppedPaths, ctx)
    if (!target) {
      return {
        success: false,
        headline: 'Which folder should I organise?',
        evidence: [],
        handoffToPlanner: 'no folder was identified from the request or the dropped files'
      }
    }

    ctx.progress('Looking through the folder')
    const entries = await listFolder(ctx, target)
    if (!entries) {
      return { success: false, headline: `I could not read ${target}.`, evidence: [], unresolved: 'folder unreadable' }
    }

    const files = entries.filter((e) => e.kind === 'file')
    if (files.length < 2) {
      return {
        success: true,
        headline: `Nothing to do — ${target} has ${files.length} file${files.length === 1 ? '' : 's'} in it.`,
        evidence: [{ kind: 'path', label: 'Folder', value: target }]
      }
    }

    // --- Enumerate strategies locally, then let Jev pick one. ---------------
    const projects = candidateProjectGroups(files)
    const months = candidateDateGroups(files)
    const typesPresent = [...new Set(files.map((f) => typeGroupFor(f.ext)).filter((g): g is string => !!g))]

    const strategies: Record<string, string> = {}
    if (typesPresent.length >= 2) {
      strategies.type = `Group by kind of file: ${typesPresent.slice(0, 5).join(', ')}.`
    }
    if (projects.length >= 2) {
      strategies.project = `Group by project or subject, using names that recur in the filenames: ${projects.join(', ')}.`
    }
    if (months.length >= 2) {
      strategies.date = `Group by the month each file was last changed: ${months.slice(0, 4).join(', ')}.`
    }
    if (Object.keys(strategies).length === 0) {
      return {
        success: true,
        headline: `These ${files.length} files do not fall into obvious groups, so I left them alone.`,
        evidence: [{ kind: 'path', label: 'Folder', value: target }]
      }
    }

    ctx.progress('Working out the groups')
    let strategy = Object.keys(strategies)[0]!
    const pick = await ctx.ask(
      'choose_grouping',
      {
        userRequest: request,
        folder: target,
        fileNames: files.slice(0, 60).map((f) => f.name)
      },
      {
        strategy: choice('Which way of grouping these files would the user most likely want?', strategies)
      }
    )
    if (pick) {
      strategy = pick.strategy.choice
      ctx.log('info', `Jev chose grouping by ${strategy}`, { confidence: pick.strategy.confidence })
    } else {
      // No Jev: prefer project grouping when the filenames suggest one, since
      // that is the more useful answer when it applies at all.
      strategy = strategies.project ? 'project' : strategies.type ? 'type' : 'date'
      ctx.log('info', `Jev unavailable; grouping by ${strategy} using local rules`)
    }

    // --- Assign files to the groups that strategy produced. -----------------
    const assignment = await assignFiles(files, strategy, projects, ctx, request)
    const moves = [...assignment.entries()]
      .filter(([, group]) => group !== null)
      .map(([file, group]) => ({
        from: file.path,
        to: join(target, group!, file.name),
        kind: 'move'
      }))

    if (moves.length === 0) {
      return {
        success: true,
        headline: 'Nothing needed moving.',
        evidence: [{ kind: 'path', label: 'Folder', value: target }]
      }
    }

    // --- Preview, then act. -------------------------------------------------
    const groupNames = [...new Set(moves.map((m) => m.to.split('/').slice(-2, -1)[0]!))]
    const approval = await ctx.askUser({
      reason: 'ambiguous',
      prompt: `Move ${moves.length} file${moves.length === 1 ? '' : 's'} into ${groupNames.length} folder${groupNames.length === 1 ? '' : 's'}?`,
      allowFreeText: false,
      preview: {
        title: `Organise ${target.split('/').pop()} by ${strategy}`,
        fileOps: moves,
        note: `New folders: ${groupNames.join(', ')}`
      },
      options: [
        { id: 'approve', label: 'Do it' },
        { id: 'reject', label: 'Cancel' }
      ]
    })
    if (approval.optionId !== 'approve') {
      return { success: false, headline: 'Cancelled — nothing was moved.', evidence: [], unresolved: 'user declined' }
    }

    ctx.progress(`Moving ${moves.length} files`)
    let moved = 0
    const failures: string[] = []
    const createdFolders = new Set<string>()

    for (const group of groupNames) {
      await ctx.checkpoint()
      const folder = join(target, group)
      const res = await ctx.run('files_create_folder', { path: folder })
      if (res.ok) createdFolders.add(folder)
      else failures.push(`could not create ${group}: ${res.error}`)
    }

    for (const move of moves) {
      await ctx.checkpoint()
      const res = await ctx.run('files_move', { from: move.from, to: move.to, onConflict: 'rename' })
      if (res.ok) moved++
      else failures.push(`${move.from.split('/').pop()}: ${res.error}`)
    }

    const evidence = [...createdFolders].map((f) => ({
      kind: 'path' as const,
      label: f.split('/').pop() ?? f,
      value: f
    }))
    evidence.unshift({ kind: 'path', label: 'Folder', value: target })

    return {
      success: failures.length === 0,
      headline:
        failures.length === 0
          ? `Sorted ${moved} file${moved === 1 ? '' : 's'} into ${groupNames.length} folder${groupNames.length === 1 ? '' : 's'}.`
          : `Moved ${moved} of ${moves.length} files; ${failures.length} did not move.`,
      evidence,
      ...(failures.length ? { unresolved: failures.slice(0, 3).join('; ') } : {})
    }
  }
}

/** Picks the folder to work on from the drop, then from the request wording. */
function pickTargetFolder(droppedPaths: string[], ctx: WorkflowContext): string | null {
  if (droppedPaths.length === 1) return droppedPaths[0]!
  if (droppedPaths.length > 1) {
    // Several drops: their common parent is the folder being organised.
    const parts = droppedPaths[0]!.split('/')
    let common = ''
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join('/')
      if (droppedPaths.every((p) => p.startsWith(prefix + '/') || p === prefix)) common = prefix
    }
    if (common) return common
  }
  const roots = ctx.authorizedRoots()
  return roots[0] ?? null
}

/**
 * Assigns each file to a group. Type and date grouping are pure functions of
 * the file, so no call is made at all; only project grouping is a judgment,
 * and that is the one Jev answers.
 */
async function assignFiles(
  files: FileEntry[],
  strategy: string,
  projects: string[],
  ctx: WorkflowContext,
  request: string
): Promise<Map<FileEntry, string | null>> {
  const out = new Map<FileEntry, string | null>()

  if (strategy === 'type') {
    for (const f of files) out.set(f, typeGroupFor(f.ext))
    return out
  }
  if (strategy === 'date') {
    for (const f of files) out.set(f, dateGroupFor(f.modifiedAt))
    return out
  }

  // Project grouping: Jev chooses between the names local code derived.
  const criteria: Record<string, string> = { unsorted: 'Does not clearly belong to any of these projects.' }
  for (const p of projects) criteria[p] = `Relates to "${p}".`

  const BATCH = 40
  for (let i = 0; i < files.length; i += BATCH) {
    await ctx.checkpoint()
    const batch = files.slice(i, i + BATCH)
    const questions: Record<string, ReturnType<typeof choice>> = {}
    batch.forEach((_f, idx) => {
      questions[`f${idx}`] = choice(`Which project does file ${idx} belong to?`, criteria)
    })

    const answers = await ctx.ask(
      'assign_files',
      {
        userRequest: request,
        files: batch.map((f, idx) => ({ index: idx, name: f.name, extension: f.ext }))
      },
      questions
    )

    batch.forEach((f, idx) => {
      const answer = answers?.[`f${idx}`]
      if (!answer || answer.type !== 'choice' || answer.choice === 'unsorted') {
        // Without Jev, fall back to a plain substring match on the filename.
        const guess = projects.find((p) => f.name.toLowerCase().includes(p.toLowerCase()))
        out.set(f, guess ?? null)
        return
      }
      out.set(f, answer.choice)
    })
  }
  return out
}

/** Exported for tests: is this folder already tidy enough to leave alone? */
export async function looksAlreadyTidy(files: FileEntry[], ctx: WorkflowContext): Promise<boolean> {
  const answers = await ctx.ask(
    'already_tidy',
    { fileNames: files.slice(0, 40).map((f) => f.name) },
    { tidy: noul('Is this folder already well organised, so that moving things would not help?') }
  )
  return isYes(answers?.tidy)
}
