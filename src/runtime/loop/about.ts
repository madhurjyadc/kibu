import type { OsAdapter } from '../../os/adapter.js'
import type { Evidence } from '../../shared/types.js'

/**
 * Answering "what are you?" without a model call.
 *
 * This used to go to the planner: several seconds and a round trip to have
 * Kibu describe itself. The answer is a fact about this build — which tools
 * are compiled in, which permissions this Mac has granted — so it is composed
 * from those facts directly. That also makes it impossible for the answer to
 * drift from what Kibu can really do, which a model-written answer cannot
 * promise.
 */

const GREETING = String.raw`(?:(?:hi|hey|hello|yo|sup|heya)\b[\s,!.]*)*`
const QUESTION = String.raw`(?:(?:what|wat|who)\s+(?:can|do|are|r)\s+(?:u|you|kibu)(?:\s+do)?|help|capabilities)`
/**
 * Anchored at both ends on purpose. "help" alone is a question about Kibu;
 * "help me rename these screenshots" is a job, and so is "what can you do
 * about the mess in my Downloads". Matching loosely would swallow both.
 */
/** The way people actually finish the question: "what can you do bro?", "…for me lol". */
const TAIL = String.raw`(?:\s+for\s+me)?(?:[\s,]+(?:bro|bruh|man|dude|buddy|mate|kibu|lol|lmao|haha|pls|please|exactly|again))*`
const ABOUT = new RegExp(`^${GREETING}${QUESTION}${TAIL}\\s*[?!.]*$`, 'i')

export function isAboutKibu(request: string): boolean {
  return ABOUT.test(request.trim())
}

export interface SelfDescription {
  headline: string
  evidence: Evidence[]
}

export function describeSelf(os: OsAdapter, canPlan: boolean, workflowsEnabled: boolean): SelfDescription {
  const canSeeApps = os.supports('window.inspect')
  const canCapture = os.supports('window.capture')

  const evidence: Evidence[] = [
    {
      kind: 'text',
      label: 'Files and folders',
      value:
        'Look through folders, find things by name, kind or date, sort them into groups, and rename in bulk. ' +
        'You see a preview before anything moves, and you can undo moves afterwards.'
    },
    {
      kind: 'text',
      label: 'Your Mac',
      value: canSeeApps
        ? 'Read what is in a window and press its buttons or fill its fields through accessibility, rather ' +
          'than clicking at coordinates and hoping.'
        : 'Blocked right now. macOS has not granted me Accessibility, so I cannot see any window or press ' +
          'anything. Open /tune and let me in, and this turns on.'
    },
    {
      kind: 'text',
      label: 'The web',
      value:
        'Open pages, fill forms and download things in my own separate browser, so nothing touches the one ' +
        'you are signed into.'
    },
    {
      kind: 'text',
      label: 'How I work',
      value:
        'I look before I act, do the work through real operations rather than by driving your mouse, check ' +
        'that what I claimed actually happened, and stop to ask when a choice is really yours. ' +
        (canCapture ? '' : 'I cannot take pictures of windows: Screen Recording is not granted. ')
    },
    {
      kind: 'text',
      label: 'Try me with',
      value: workflowsEnabled
        ? '"tidy up my Downloads", "find the invoice I saved yesterday", "give these files proper names" — ' +
          'those three run on local code and Jev in about a second, with no planning model at all.'
        : '"tidy up my Downloads", "find the invoice I saved yesterday", "give these files proper names".'
    }
  ]

  if (!canPlan) {
    evidence.push({
      kind: 'text',
      label: 'Not set up yet',
      value: 'I have no way to think about anything open-ended. Give me a key under /keys, or let me use the ' +
        'Claude Code on this Mac under /tune.'
    })
  }

  return {
    headline: canSeeApps
      ? "I'm Kibu. I work on your Mac: your files, your apps, and the web — and I show you what I actually did."
      : "I'm Kibu. I work on your files and the web today, and on your apps as soon as you let me see them.",
    evidence
  }
}
