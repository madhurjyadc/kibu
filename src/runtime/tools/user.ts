import { z } from 'zod'
import type { ToolDefinition } from './registry.js'

/**
 * Tools the assistant uses to talk to the person rather than to the machine.
 * They are ordinary tools so the loop, the limits and the history treat them
 * exactly like any other step.
 */

export const reportProgress: ToolDefinition = {
  name: 'report_progress',
  description:
    'Update the short line in the pet\'s speech bubble. Use plain language describing what is happening right now, e.g. "Moving 12 files". Call this before any step that takes more than a moment.',
  capability: 'user.interact',
  input: z.object({
    line: z.string().min(1).max(80).describe('Six words or fewer works best')
  }),
  scopes: () => [],
  async execute(i, ctx) {
    ctx.progress(i.line)
    return { result: { line: i.line } }
  }
}

export const showPreview: ToolDefinition = {
  name: 'show_preview',
  description:
    'Show the user exactly what you are about to change and wait for approval. Use this before any batch of file moves. Returns whether they approved.',
  capability: 'user.interact',
  input: z.object({
    title: z.string().min(1).describe('e.g. "Organise Downloads into 4 folders"'),
    fileOps: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          kind: z.string().describe('e.g. "move" or "rename"')
        })
      )
      .optional(),
    note: z.string().optional().describe('Anything the user should know before approving')
  }),
  scopes: () => [],
  async execute(i, ctx) {
    const answer = await ctx.ask({
      reason: 'ambiguous',
      prompt: i.title,
      allowFreeText: true,
      preview: { title: i.title, fileOps: i.fileOps, note: i.note },
      options: [
        { id: 'approve', label: 'Do it' },
        { id: 'reject', label: 'Cancel' }
      ]
    })
    const approved = answer.optionId === 'approve'
    return {
      result: {
        approved,
        // Free text is how the user redirects: "yes but keep the PDFs together".
        feedback: answer.text ?? null
      }
    }
  }
}

export const askUser: ToolDefinition = {
  name: 'ask_user',
  description:
    'Ask the user a question and wait for an answer. Use this only when the request is genuinely ambiguous in a way that changes what you would do, not to confirm steps you are already authorized to take.',
  capability: 'user.interact',
  input: z.object({
    prompt: z.string().min(1),
    options: z
      .array(z.object({ id: z.string(), label: z.string(), detail: z.string().optional() }))
      .optional()
      .describe('Offer concrete choices when you can; it is faster than free text'),
    allowFreeText: z.boolean().default(true)
  }),
  scopes: () => [],
  async execute(i, ctx) {
    const answer = await ctx.ask({
      reason: 'ambiguous',
      prompt: i.prompt,
      options: i.options,
      allowFreeText: i.allowFreeText
    })
    return { result: { optionId: answer.optionId, text: answer.text ?? null } }
  }
}

export const finishTask: ToolDefinition = {
  name: 'finish',
  description:
    'Declare the task complete or blocked. Only call this after you have verified the outcome. Supply evidence the user can open: destination folders, created files, URLs. If a required step is unresolved, report success=false and say what is missing.',
  capability: 'user.interact',
  input: z.object({
    success: z.boolean(),
    headline: z
      .string()
      .min(1)
      .describe('For work: one sentence, past tense, e.g. "Sorted 23 files into 4 folders". For a question: the answer itself, addressed to the user.'),
    evidence: z
      .array(
        z.object({
          kind: z.enum(['path', 'url', 'text']),
          label: z.string(),
          value: z.string()
        })
      )
      .default([]),
    unresolved: z.string().optional().describe('What is still outstanding, if anything')
  }),
  scopes: () => [],
  async execute(i) {
    return { result: i }
  }
}

export const userTools: ToolDefinition[] = [reportProgress, showPreview, askUser, finishTask]
