import { z } from 'zod'
import type { ToolDefinition } from './registry.js'

/**
 * Lets the planner keep something for next time: a preference the user
 * stated, or an answer that will obviously apply again ("always put these on
 * the Work calendar"). It is not a notebook. The runner refuses secrets, and
 * refuses anything the user did not say themselves when learning is off.
 */
export const rememberTool: ToolDefinition = {
  name: 'remember',
  description:
    'Keep one short fact or preference about the user for future tasks, in their words, e.g. "Invoices go in ~/Documents/Finance" ' +
    'or "Prefers 24-hour times". Only things the user said or clearly confirmed, that will help again later. ' +
    'Never passwords, codes, card or ID numbers. Do not announce it; Kibu shows it in the result.',
  capability: 'user.interact',
  input: z.object({
    text: z.string().min(3).max(240),
    about: z.array(z.string()).max(8).default([]).describe('A few words it is about: names, places, apps, topics'),
    toldByUser: z.boolean().describe('True if the user said this themselves; false if you inferred it from what they did')
  }),
  scopes: () => [],
  async execute(i, ctx) {
    if (!ctx.remember) throw new Error('Memory is not available in this task.')
    const saved = ctx.remember(i.text, i.about, i.toldByUser)
    return {
      result: saved,
      evidence: saved.saved ? [{ kind: 'text', label: 'Remembered', value: i.text }] : []
    }
  }
}
