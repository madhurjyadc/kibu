import { choice } from '../model/jev.js'
import { explicitMemory, lexicalScore, looksSecret, makeMemory, words } from '../memory.js'
import type { Memory } from '../../shared/types.js'
import type { Workflow, WorkflowResult } from './types.js'

/**
 * "Remember that my manager is Priya", "forget that", "what do you remember
 * about me" — handled in code, instantly, with no planning model. The person
 * should never need a settings screen to know or change what Kibu keeps.
 */

const ALL_ROUTES = ['files', 'desktop', 'browser', 'apps', 'mixed', 'unclear']
const FORGET = /^\s*(?:please |kibu[, ]+)*(?:forget|stop remembering|delete the memory|unlearn)\b\s*(?:that |about |what you know about |everything you know about )?(.*)$/i
const FORGET_ALL = /^\s*(?:please |kibu[, ]+)*(?:forget everything|clear (?:your |all )?memor(?:y|ies)|wipe (?:your )?memory|forget all (?:of )?(?:it|that|about me))\b/i
const ASK = /\bwhat (?:do|did) you (?:remember|know|learn(?:ed)?)(?: about)?\s*(.*?)\??$|\bwhat have you learned\b|\bshow (?:me )?(?:your )?memor(?:y|ies)\b/i

const list = (ms: Memory[]): string => ms.map((m) => `• ${m.text}`).join('\n')

export const memoryWorkflow: Workflow = {
  id: 'memory',
  description: 'Remember something the user says about themselves, forget something, or say what is remembered.',
  routes: ALL_ROUTES,
  plausible: (request) => FORGET_ALL.test(request) || ASK.test(request) || explicitMemory(request) !== null || (FORGET.test(request) && !/^\s*forget it\s*$/i.test(request)),

  async run(request, _dropped, ctx): Promise<WorkflowResult> {
    const mem = ctx.memory
    if (!mem.enabled) {
      return { success: false, headline: "Memory is off, so I'm not keeping anything. You can turn it on in Settings.", evidence: [] }
    }

    if (FORGET_ALL.test(request)) {
      const all = mem.all()
      if (all.length === 0) return { success: true, headline: "There's nothing to forget — I don't remember anything yet.", evidence: [] }
      const answer = await ctx.askUser({
        reason: 'authorization',
        prompt: `Forget all ${all.length} things I remember about you? This can't be undone.`,
        allowFreeText: false,
        options: [{ id: 'yes', label: 'Forget everything' }, { id: 'no', label: 'Keep them' }]
      })
      if (answer.optionId !== 'yes') return { success: true, headline: 'Kept everything.', evidence: [] }
      mem.forget(all.map((m) => m.id))
      return { success: true, headline: `Done. I've forgotten all ${all.length}.`, evidence: [] }
    }

    const asking = ASK.exec(request)
    if (asking) {
      const about = (asking[1] ?? '').replace(/^(?:me|myself)\b/i, '').trim()
      const all = [...mem.all()].sort((a, b) => b.uses - a.uses || b.updatedAt - a.updatedAt)
      const shown = about ? all.filter((m) => lexicalScore(about, m) > 0) : all
      if (shown.length === 0) {
        return { success: true, headline: about ? `I don't remember anything about ${about}.` : "I don't remember anything about you yet. Tell me with \"remember that …\".", evidence: [] }
      }
      const told = shown.filter((m) => m.source === 'told')
      const learned = shown.filter((m) => m.source === 'learned')
      return {
        success: true,
        headline: `I remember ${shown.length} thing${shown.length === 1 ? '' : 's'}${about ? ` about ${about}` : ''}. Say "forget …" to drop one.`,
        evidence: [
          ...(told.length ? [{ kind: 'text' as const, label: 'You told me', value: list(told.slice(0, 30)) }] : []),
          ...(learned.length ? [{ kind: 'text' as const, label: 'I picked up', value: list(learned.slice(0, 30)) }] : [])
        ]
      }
    }

    const told = explicitMemory(request)
    if (told) {
      const secret = looksSecret(told.text)
      if (secret) return { success: false, headline: `I don't keep ${secret}, even when asked — they're safer in your password manager.`, evidence: [] }
      const kept = mem.keep(makeMemory(told.text, told.kind, 'told'))
      if (!kept) return { success: false, headline: "I couldn't keep that one.", evidence: [] }
      return { success: true, headline: `Got it. I'll remember that.`, evidence: [{ kind: 'text', label: 'Remembered', value: kept.text }] }
    }

    // Forget one thing: the closest match, or ask which when it is unclear.
    const what = FORGET.exec(request)?.[1]?.trim() ?? ''
    const candidates = mem.all()
      .map((m) => ({ m, score: lexicalScore(what, m) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    if (candidates.length === 0) return { success: true, headline: `I don't remember anything about ${what || 'that'}.`, evidence: [] }
    let target: Memory | null = candidates.length === 1 || candidates[0]!.score > candidates[1]!.score * 1.5 ? candidates[0]!.m : null
    if (!target) {
      const top = candidates.slice(0, 6)
      const options: Record<string, string> = {}
      top.forEach((c, i) => { options[`m${i}`] = c.m.text })
      const answers = await ctx.ask('pick_memory', { request }, { which: choice('Which remembered thing does the user want forgotten?', options) })
      const pick = (answers?.which as { choice?: string; confidence?: number } | undefined)
      if (pick?.choice && (pick.confidence ?? 0) > 0.7) target = top[Number(pick.choice.slice(1))]?.m ?? null
      if (!target) {
        const answer = await ctx.askUser({
          reason: 'ambiguous',
          prompt: 'Which one should I forget?',
          allowFreeText: false,
          options: [...top.map((c, i) => ({ id: `m${i}`, label: c.m.text.slice(0, 80) })), { id: 'none', label: 'None of these' }]
        })
        target = answer.optionId && answer.optionId !== 'none' ? top[Number(answer.optionId.slice(1))]?.m ?? null : null
      }
    }
    if (!target) return { success: true, headline: 'Okay, I kept everything.', evidence: [] }
    mem.forget([target.id])
    return { success: true, headline: 'Forgotten.', evidence: [{ kind: 'text', label: 'No longer remembered', value: target.text }] }
  }
}

/** Words a request is "about", minus the verbs that start it. Used to key learned choices. */
export function aboutWords(text: string): string[] {
  return words(text.replace(/\b(run|start|trigger|shortcut|please)\b/gi, ' '))
}
