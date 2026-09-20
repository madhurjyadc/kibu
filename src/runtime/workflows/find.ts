import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseQuery, type FoundFile } from '../tools/search.js'
import type { Workflow, WorkflowContext, WorkflowResult } from './types.js'

/**
 * "Find the PDF I downloaded yesterday."
 *
 * This used to ask Jev to pick filters, search one guessed folder by date
 * only — never by the words the user typed — and then ask which of five
 * files they meant. It found the wrong thing slowly and made the user do the
 * work.
 *
 * Now the sentence is read in code, the macOS index answers in about 200ms,
 * and ranking happens locally. Nothing is asked: the best match comes back
 * with the runners-up beside it, so picking a different one is a click rather
 * than a conversation.
 */
export const findWorkflow: Workflow = {
  id: 'find_files',
  description: 'Find a file the user is describing from memory and show them where it is.',
  routes: ['files'],

  plausible(request) {
    // "search for flights" is a find verb aimed at the web, not at the disk.
    if (/\b(safari|chrome|firefox|arc|browser|web|online|google|website|site|url|email|inbox|message|slack)\b/i.test(request)) {
      return false
    }
    return /\b(find|locate|where is|where are|where’s|where's|look for|search for|open the|show me|dig up|latest|most recent)\b/i.test(request)
  },

  async run(request, droppedPaths, ctx): Promise<WorkflowResult> {
    const parsed = parseQuery(request)
    // Precedence: a folder the user actually put in front of me, then one they
    // named in the sentence, then their whole home. Searching everything is
    // the right default — the index makes it cheap — but never when they have
    // already said where to look.
    const scoped = ctx.authorizedRoots()
    const root = scoped[0] ?? (parsed.folder ? join(homedir(), parsed.folder) : homedir())

    ctx.progress('Searching…')

    const res = await ctx.run('files_find', {
      terms: parsed.words.join(' '),
      folder: root,
      ...(parsed.extensions.length ? { extensions: parsed.extensions } : {}),
      ...(parsed.modifiedAfter ? { modifiedAfter: parsed.modifiedAfter } : {}),
      limit: 8
    })
    if (!res.ok) {
      return { success: false, headline: 'The search failed.', evidence: [], handoffToPlanner: res.error }
    }

    const matches = (res.result as { matches: FoundFile[] }).matches
    if (matches.length === 0) {
      // Widening to the whole home is free, so try that before giving up.
      const wider =
        root === homedir() || scoped.length > 0
          ? null
          : await ctx.run('files_find', {
              terms: parsed.words.join(' '),
              ...(parsed.extensions.length ? { extensions: parsed.extensions } : {}),
              limit: 8
            })
      const widened = wider?.ok ? (wider.result as { matches: FoundFile[] }).matches : []
      if (widened.length === 0) {
        return {
          success: false,
          headline: describeNothing(parsed),
          evidence: [],
          unresolved: `searched ${root === homedir() ? 'your home folder' : root}`
        }
      }
      return present(widened, ctx)
    }

    return present(matches, ctx)
  }
}

/**
 * The best match, with the alternatives underneath it.
 *
 * Deliberately not a question. The user asked for a file, not for a quiz, and
 * every row here is one click from opening.
 */
function present(matches: FoundFile[], ctx: WorkflowContext): WorkflowResult {
  const best = matches[0]!
  const rest = matches.slice(1, 5)
  ctx.log('info', `found ${matches.length} matches, best ${best.path}`, { score: best.score })

  return {
    success: true,
    headline: `${Math.min(matches.length, 5)} match${matches.length === 1 ? '' : 'es'}`,
    evidence: [
      { kind: 'path', label: best.name, value: best.path },
      ...rest.map((m) => ({ kind: 'path' as const, label: m.name, value: m.path }))
    ]
  }
}

function describeNothing(_parsed: ReturnType<typeof parseQuery>): string {
  return 'Could not find a match. Try a filename or folder.'
}
