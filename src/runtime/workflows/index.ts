import { choice } from '../model/jev.js'
import { organizeWorkflow } from './organize.js'
import { findWorkflow } from './find.js'
import { renameWorkflow } from './rename.js'
import { commandWorkflow } from './command.js'
import type { Workflow, WorkflowContext } from './types.js'

export const WORKFLOWS: Workflow[] = [organizeWorkflow, findWorkflow, renameWorkflow, commandWorkflow]

export interface WorkflowMatch {
  workflow: Workflow
  confidence: number
  reason: string
}

/**
 * Picks a workflow for a request, or returns null to hand off to the planner.
 *
 * Local plausibility checks narrow the field first, so a request that clearly
 * matches exactly one workflow costs nothing to route. Jev is asked only when
 * more than one is plausible, and it chooses between the shortlist — including
 * an explicit "none of these" option, so it can decline.
 */
export async function routeToWorkflow(
  request: string,
  droppedPaths: string[],
  ctx: Pick<WorkflowContext, 'ask' | 'log'>,
  /** What the router decided this request is about. */
  route: string
): Promise<WorkflowMatch | null> {
  // Keyword matching alone may not claim a request. Each workflow declares
  // the routes it belongs to, and the route — local rules, or Jev when they
  // are unsure — decides what kind of work this is. That gate is why "open
  // youtube and search for a good video" no longer searches the Downloads
  // folder for a video file.
  const effective = route === 'unclear' && droppedPaths.length > 0 ? 'files' : route
  const plausible = WORKFLOWS.filter(
    (w) => w.routes.includes(effective) && w.plausible(request, droppedPaths)
  )
  if (plausible.length === 0) {
    ctx.log('info', `nothing matches a "${effective}" request; handing to the planner`)
    return null
  }
  if (plausible.length === 0) return null
  if (plausible.length === 1) {
    return { workflow: plausible[0]!, confidence: 0.8, reason: 'the request matches one known workflow' }
  }

  const criteria: Record<string, string> = {
    none: 'None of these fit; this needs general-purpose planning.'
  }
  for (const w of plausible) criteria[w.id] = w.description

  const answers = await ctx.ask(
    'route_workflow',
    { userRequest: request, filesDropped: droppedPaths.length },
    { workflow: choice('Which of these jobs is the user asking for?', criteria) }
  )
  if (!answers) {
    // No Jev: take the first plausible match rather than stalling.
    return { workflow: plausible[0]!, confidence: 0.5, reason: 'first plausible match (Jev unavailable)' }
  }
  const pick = answers.workflow
  // Defend against an unexpected answer shape rather than throwing inside the
  // router: falling back to the planner is always a safe outcome.
  if (!pick || pick.type !== 'choice') {
    ctx.log('warn', 'Jev returned no usable workflow choice; handing off to the planner')
    return null
  }
  if (pick.choice === 'none') {
    ctx.log('info', 'Jev declined all workflows; handing off to the planner')
    return null
  }
  const workflow = plausible.find((w) => w.id === pick.choice)
  if (!workflow) return null
  return {
    workflow,
    confidence: pick.confidence,
    reason: `Jev chose ${workflow.id} (${(pick.confidence * 100).toFixed(0)}% confident)`
  }
}

export type { Workflow, WorkflowContext, WorkflowResult } from './types.js'
