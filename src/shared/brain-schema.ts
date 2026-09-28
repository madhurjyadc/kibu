import { z } from 'zod'

export const brainKind = z.enum(['note', 'task', 'reminder', 'project', 'bookmark', 'session', 'tracker'])
export const sourceSchema = z.object({ kind: z.enum(['path', 'url']), label: z.string().max(300), value: z.string().min(1).max(4000) }).strict()
export const brainFields = z.object({
  kind: brainKind,
  title: z.string().trim().min(1).max(300),
  body: z.string().max(40000).default(''),
  projectId: z.string().max(100).nullable().default(null),
  dueAt: z.number().int().min(0).max(8640000000000000).nullable().default(null),
  repeat: z.enum(['none', 'daily', 'weekly']).default('none'),
  estimateMinutes: z.number().int().min(1).max(1440).nullable().default(null),
  sources: z.array(sourceSchema).max(100).default([])
}).strict()

const id = z.string().min(1).max(100)
export const brainRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), id: id.optional(), query: z.string().max(300).optional(), kind: brainKind.optional(), projectId: id.optional() }).strict(),
  z.object({ op: z.literal('create'), item: brainFields }).strict(),
  z.object({ op: z.literal('update'), id, changes: z.object({
    kind: brainKind.optional(), title: brainFields.shape.title.optional(),
    body: brainFields.shape.body.removeDefault().optional(),
    projectId: brainFields.shape.projectId.removeDefault().optional(),
    dueAt: brainFields.shape.dueAt.removeDefault().optional(),
    repeat: brainFields.shape.repeat.removeDefault().optional(),
    estimateMinutes: brainFields.shape.estimateMinutes.removeDefault().optional(),
    sources: brainFields.shape.sources.removeDefault().optional()
  }).strict() }).strict(),
  z.object({ op: z.literal('complete'), id }).strict(),
  z.object({ op: z.literal('reopen'), id }).strict(),
  z.object({ op: z.literal('archive'), id }).strict(),
  z.object({ op: z.literal('acknowledge'), id }).strict(),
  z.object({ op: z.literal('snooze'), id, minutes: z.number().int().min(1).max(10080) }).strict(),
  z.object({ op: z.literal('check'), id }).strict(),
  z.object({ op: z.literal('timer'), action: z.enum(['start', 'pause', 'resume', 'cancel']), minutes: z.number().min(1 / 60).max(1440).optional(), label: z.string().trim().min(1).max(100).optional() }).strict()
])
