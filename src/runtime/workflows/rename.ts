import { basename, dirname, extname, join } from 'node:path'
import { choice } from '../model/jev.js'
import { listFolder, type FileEntry } from './common.js'
import type { Workflow, WorkflowContext, WorkflowResult } from './types.js'

/**
 * "Rename these files consistently."
 *
 * The naming schemes are fixed functions, so the rename itself is fully
 * deterministic and previewable. Jev's only job is picking which scheme the
 * user meant — exactly a choice between declared options.
 */

type Scheme = (name: string, index: number, file: FileEntry) => string

const SCHEMES: Record<string, { description: string; apply: Scheme }> = {
  kebab: {
    description: 'Lower case with hyphens, e.g. "quarterly-report-final.pdf".',
    apply: (stem) => slug(stem, '-')
  },
  snake: {
    description: 'Lower case with underscores, e.g. "quarterly_report_final.pdf".',
    apply: (stem) => slug(stem, '_')
  },
  title: {
    description: 'Title Case With Spaces, e.g. "Quarterly Report Final.pdf".',
    apply: (stem) =>
      slug(stem, ' ')
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
  },
  date_prefix: {
    description: 'Prefixed with the date the file was last changed, e.g. "2026-09-20-report.pdf".',
    apply: (stem, _i, file) => `${new Date(file.modifiedAt).toISOString().slice(0, 10)}-${slug(stem, '-')}`
  },
  numbered: {
    description: 'Numbered in order, e.g. "01-report.pdf", "02-notes.pdf".',
    apply: (stem, index) => `${String(index + 1).padStart(2, '0')}-${slug(stem, '-')}`
  }
}

function slug(value: string, separator: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .join(separator)
}

export const renameWorkflow: Workflow = {
  id: 'rename_batch',
  description: 'Rename a group of files so they follow one consistent naming pattern.',
  routes: ['files'],

  plausible(request) {
    return /\b(rename|renaming|consistent|naming|name these|tidy up the names)\b/i.test(request)
  },

  async run(request, droppedPaths, ctx): Promise<WorkflowResult> {
    const files = await collectFiles(droppedPaths, ctx)
    if (files.length === 0) {
      return {
        success: false,
        headline: 'Which files should I rename? Drop them on me, or name a folder.',
        evidence: [],
        handoffToPlanner: 'no files were identified to rename'
      }
    }

    ctx.progress('Choosing a naming pattern')
    const answers = await ctx.ask(
      'choose_scheme',
      {
        userRequest: request,
        currentNames: files.slice(0, 40).map((f) => f.name)
      },
      {
        scheme: choice(
          'Which naming pattern does the user want these files renamed to?',
          Object.fromEntries(Object.entries(SCHEMES).map(([k, v]) => [k, v.description]))
        )
      }
    )

    const schemeId = answers?.scheme.choice ?? localScheme(request)
    const scheme = SCHEMES[schemeId] ?? SCHEMES.kebab!
    ctx.log('info', `renaming with the "${schemeId}" pattern`)

    // Sorting by name first makes "numbered" stable and predictable.
    const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name))
    const ops = ordered
      .map((file, index) => {
        const ext = extname(file.name)
        const stem = basename(file.name, ext)
        const renamed = `${scheme.apply(stem, index, file)}${ext.toLowerCase()}`
        return { from: file.path, to: join(dirname(file.path), renamed), kind: 'rename', changed: renamed !== file.name }
      })
      .filter((op) => op.changed)

    if (ops.length === 0) {
      return {
        success: true,
        headline: 'These files already follow that pattern.',
        evidence: files.slice(0, 3).map((f) => ({ kind: 'path' as const, label: f.name, value: f.path }))
      }
    }

    const approval = await ctx.askUser({
      reason: 'ambiguous',
      prompt: `Rename ${ops.length} file${ops.length === 1 ? '' : 's'}?`,
      allowFreeText: false,
      preview: {
        title: `Rename using the "${schemeId}" pattern`,
        fileOps: ops.map((o) => ({ from: o.from, to: o.to, kind: 'rename' })),
        note: SCHEMES[schemeId]?.description
      },
      options: [
        { id: 'approve', label: 'Rename them' },
        { id: 'reject', label: 'Cancel' }
      ]
    })
    if (approval.optionId !== 'approve') {
      return { success: false, headline: 'Cancelled — nothing was renamed.', evidence: [], unresolved: 'user declined' }
    }

    ctx.progress(`Renaming ${ops.length} files`)
    let renamed = 0
    const failures: string[] = []
    for (const op of ops) {
      await ctx.checkpoint()
      const res = await ctx.run('files_rename', { from: op.from, to: op.to, onConflict: 'rename' })
      if (res.ok) renamed++
      else failures.push(`${basename(op.from)}: ${res.error}`)
    }

    return {
      success: failures.length === 0,
      headline:
        failures.length === 0
          ? `Renamed ${renamed} file${renamed === 1 ? '' : 's'} to the "${schemeId}" pattern.`
          : `Renamed ${renamed} of ${ops.length}; ${failures.length} failed.`,
      evidence: [{ kind: 'path', label: 'Folder', value: dirname(ops[0]!.from) }],
      ...(failures.length ? { unresolved: failures.slice(0, 3).join('; ') } : {})
    }
  }
}

/** Dropped files are the selection; a dropped folder means its contents. */
async function collectFiles(droppedPaths: string[], ctx: WorkflowContext): Promise<FileEntry[]> {
  const files: FileEntry[] = []
  const sources = droppedPaths.length > 0 ? droppedPaths : ctx.authorizedRoots().slice(0, 1)

  for (const path of sources) {
    const inspected = await ctx.run('files_inspect', { path })
    if (!inspected.ok) continue
    const entry = inspected.result as FileEntry
    if (entry.kind === 'file') {
      files.push(entry)
      continue
    }
    if (entry.kind === 'directory') {
      const listed = await listFolder(ctx, path)
      if (listed) files.push(...listed.filter((e) => e.kind === 'file'))
    }
  }
  return files
}

function localScheme(request: string): string {
  const r = request.toLowerCase()
  if (/\bdate\b/.test(r)) return 'date_prefix'
  if (/\bnumber|sequential|order\b/.test(r)) return 'numbered'
  if (/\bunderscore|snake\b/.test(r)) return 'snake'
  if (/\btitle case|capitali[sz]e\b/.test(r)) return 'title'
  return 'kebab'
}

export { SCHEMES }
