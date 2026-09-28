import type { z } from 'zod'
import type { brainKind, brainFields, brainRequest, sourceSchema } from './brain-schema.js'

export type BrainKind = z.infer<typeof brainKind>
export type BrainSource = z.infer<typeof sourceSchema>
export type BrainDraft = z.input<typeof brainFields>
export interface BrainItem extends z.output<typeof brainFields> {
  id: string
  status: 'open' | 'done' | 'archived'
  createdAt: number
  updatedAt: number
  notifiedAt: number | null
  acknowledgedAt: number | null
  checks: string[]
}
export interface BrainTimer {
  id: string
  label: string
  durationMs: number
  remainingMs: number
  endsAt: number | null
  status: 'running' | 'paused' | 'ringing'
  notifiedAt: number | null
}
export interface BrainSnapshot { items: BrainItem[]; timer: BrainTimer | null }
export type BrainRequest = z.input<typeof brainRequest>
export const emptyBrain = (): BrainSnapshot => ({ items: [], timer: null })
export function dayKey(now = Date.now()): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function timerRemaining(timer: BrainTimer, now = Date.now()): number {
  return timer.status === 'running' ? Math.min(timer.durationMs, Math.max(0, (timer.endsAt ?? now) - now)) : timer.status === 'ringing' ? 0 : timer.remainingMs
}
export function timerLabel(timer: BrainTimer, now = Date.now()): string {
  const seconds = Math.ceil(timerRemaining(timer, now) / 1000)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
export function dueItems(state: BrainSnapshot, now = Date.now()): BrainItem[] {
  return state.items.filter(i => i.status === 'open' && i.dueAt !== null && i.dueAt <= now && i.acknowledgedAt === null)
    .sort((a, b) => a.dueAt! - b.dueAt!)
}
