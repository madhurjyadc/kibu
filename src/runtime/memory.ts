import { randomUUID } from 'node:crypto'
import { noul } from './model/jev.js'
import type { Jev } from './model/jev.js'
import type { Memory } from '../shared/types.js'

/**
 * What Kibu remembers, and — more importantly — when it brings it up.
 *
 * The rule is relevance. A memory reaches a task only when it would help with
 * that task: "my manager is Priya" belongs in "email my manager", not in
 * "tidy my Downloads". Local code shortlists memories that share words or a
 * topic with the request; Jev then judges each one on the shortlist with a
 * yes/no; without Jev the shortlist has to clear a stricter bar instead.
 * Nothing that fails is mentioned anywhere.
 *
 * Nothing here decides anything on its own. A remembered default is a
 * starting point the person can see ("From memory: …") and overrule.
 */

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'into',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can',
  'could', 'should', 'please', 'kibu', 'hey', 'i', 'me', 'my', 'mine', 'you', 'your', 'it', 'its', 'this', 'that',
  'these', 'those', 'there', 'here', 'what', 'when', 'where', 'which', 'who', 'how', 'why', 'all', 'any', 'some',
  'just', 'also', 'always', 'never', 'remember', 'forget', 'know', 'like', 'want', 'need', 'get', 'make', 'put',
  'add', 'set', 'up', 'out', 'new', 'now', 'today', 'tomorrow', 'tonight', 'am', 'pm', 'next', 'last', 'every',
  'thing', 'things', 'stuff', 'one', 'use', 'using', 'so', 'if', 'than', 'then', 'too', 'very', 'really', 'ok'
])

/** Lower-case word stems, with plurals folded, minus the words every request has. */
export function words(text: string): string[] {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9@.+-]+/)) {
    const w = raw.replace(/^[.+-]+|[.+-]+$/g, '')
    if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue
    out.add(w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
  }
  return [...out]
}

/** Topics a memory or a request touches, from the same words the planner setup uses. */
const TOPICS: Record<string, RegExp> = {
  calendar: /\b(calendar|meeting|event|schedule|appointment|standup|call|sync|1:1)s?\b/i,
  reminders: /\b(remind|reminder|to-?do|task)s?\b/i,
  notes: /\bnotes?\b/i,
  mail: /\b(e-?mail|mail|inbox|reply|draft|signature)s?\b/i,
  files: /\b(files?|folders?|downloads?|desktop|documents?|pdfs?|screenshots?|invoices?|receipts?)\b/i,
  web: /\b(browser|website|site|chrome|safari|arc|web)\b/i,
  time: /\b(time|clock|24-?hour|12-?hour|timezone|morning|evening|hours?)\b/i
}

export function topics(text: string): string[] {
  return Object.entries(TOPICS).filter(([, re]) => re.test(text)).map(([t]) => t)
}

/* ------------------------------------------------------------------ *
 * What must never be remembered
 * ------------------------------------------------------------------ */

/**
 * Secrets stay out of memory whatever anyone asks, because memory is shown
 * back and sent to the model when relevant. Card numbers, passwords, one-time
 * codes, keys and government ID numbers are refused here, in code.
 */
export function looksSecret(text: string): string | null {
  const t = text.toLowerCase()
  if (/\b(password|passcode|passwd|pin code|\bpin\b|otp|one[- ]time code|2fa|secret key|api key|private key|seed phrase|recovery phrase|cvv|security code)\b/.test(t)) {
    return 'passwords, codes and keys'
  }
  const digits = text.replace(/[\s-]/g, '')
  if (/\d{13,19}/.test(digits) && luhn(digits.match(/\d{13,19}/)![0])) return 'card numbers'
  if (/\b\d{4}\s?\d{4}\s?\d{4}\b/.test(text) && /aadhaa?r|uid/i.test(text)) return 'ID numbers'
  if (/\b(sk|pk|ghp|xox[abp])[-_][a-z0-9_-]{16,}\b/i.test(text)) return 'keys'
  return null
}

function luhn(n: string): boolean {
  let sum = 0
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

/* ------------------------------------------------------------------ *
 * Making memories
 * ------------------------------------------------------------------ */

export function makeMemory(
  text: string,
  kind: Memory['kind'],
  source: Memory['source'],
  extra: { keys?: string[]; choice?: Memory['choice'] } = {}
): Memory {
  const now = Date.now()
  const clean = text.replace(/\s+/g, ' ').trim()
  return {
    id: randomUUID(),
    text: clean.charAt(0).toUpperCase() + clean.slice(1),
    kind,
    keys: [...new Set([...(extra.keys ?? []), ...words(clean)])].slice(0, 16),
    ...(extra.choice ? { choice: extra.choice } : {}),
    source,
    evidence: 1,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    uses: 0
  }
}

/**
 * "Remember that my manager is Priya" → "My manager is Priya".
 * "Remember to call mom" is a reminder, not a memory, and is not claimed here.
 */
export function explicitMemory(request: string): { text: string; kind: Memory['kind'] } | null {
  const r = request.trim()
  const told =
    /^(?:hey |please |kibu[, ]+)*(?:can you |could you )?(?:remember|keep in mind|don'?t forget)\s*(?:that|:|,)\s*(.+)$/i.exec(r) ??
    /^(?:hey |please |kibu[, ]+)*(?:remember|keep in mind|don'?t forget)\s+(?!to\b)((?:my|i|i'm|i am|we|our|the)\b.+)$/i.exec(r)
  if (told) return { text: tidy(told[1]!), kind: /\b(prefer|like|love|hate|always|never|rather|don'?t like)\b/i.test(told[1]!) ? 'preference' : 'fact' }
  const standing = /^(?:from now on|going forward|in (?:the )?future),?\s+(.+)$/i.exec(r)
  if (standing) return { text: tidy(standing[1]!), kind: 'preference' }
  return null
}

function tidy(s: string): string {
  return s.replace(/[\s.!]+$/, '').replace(/^\s+/, '')
}

/** Folds a new memory into what is already known, rather than keeping near-copies. */
export function mergeMemory(existing: Memory[], incoming: Memory): { memory: Memory; replaces: string | null } {
  if (incoming.choice) {
    const same = existing.find(
      (m) => m.choice?.decision === incoming.choice!.decision && overlap(m.keys, incoming.keys) >= Math.min(m.keys.length, incoming.keys.length, 2)
    )
    if (same) {
      // Same decision about the same kind of thing: the newest answer wins,
      // and repeating an answer makes it more trusted.
      const agrees = same.choice!.value === incoming.choice.value
      return {
        memory: { ...same, text: incoming.text, choice: incoming.choice, evidence: agrees ? same.evidence + 1 : 1, updatedAt: Date.now() },
        replaces: same.id
      }
    }
  }
  const norm = (t: string): string => words(t).sort().join(' ')
  const dup = existing.find((m) => norm(m.text) === norm(incoming.text))
  if (dup) return { memory: { ...dup, evidence: dup.evidence + 1, updatedAt: Date.now() }, replaces: dup.id }
  return { memory: incoming, replaces: null }
}

function overlap(a: string[], b: string[]): number {
  const set = new Set(a)
  return b.filter((w) => set.has(w)).length
}

/* ------------------------------------------------------------------ *
 * Recall
 * ------------------------------------------------------------------ */

export interface Recalled {
  memory: Memory
  /** Why it came up, for the log. */
  why: string
}

/** How strongly a memory's words and topics match a request. Local and instant. */
export function lexicalScore(request: string, m: Memory): number {
  const req = new Set(words(request))
  const keyHits = m.keys.filter((k) => req.has(k)).length
  const topicHits = topics(request).filter((t) => topics(m.text).includes(t)).length
  // A shared name or distinctive word counts for much more than a shared topic.
  return keyHits * 2 + topicHits
}

/**
 * The memories worth knowing for this request, at most `limit`.
 *
 * With Jev: a shortlist (anything sharing a word or topic, or every memory
 * when there are only a few) goes to Jev in one call, one yes/no each, and
 * only the clear yeses come back. Without Jev: only memories sharing a
 * distinctive word with the request.
 */
export async function recall(request: string, memories: Memory[], jev: Jev | null, limit = 6): Promise<Recalled[]> {
  if (memories.length === 0) return []
  const scored = memories
    .map((m) => ({ m, score: lexicalScore(request, m) }))
    .sort((a, b) => b.score - a.score || (b.m.uses - a.m.uses))

  if (!jev?.available) {
    return scored
      .filter((s) => s.score >= 2)
      .slice(0, limit)
      .map((s) => ({ memory: s.m, why: `shares "${s.m.keys.filter((k) => words(request).includes(k)).join('", "')}"` }))
  }

  // A handful of memories can all be judged; more than that are shortlisted
  // first, so the call stays small and fast.
  const shortlist = (memories.length <= 16 ? scored : scored.filter((s) => s.score > 0)).slice(0, 16)
  if (shortlist.length === 0) return []
  const questions: Record<string, ReturnType<typeof noul>> = {}
  shortlist.forEach((s, i) => {
    questions[`m${i}`] = noul(`Would knowing this help with the request? "${s.m.text}"`, {
      true: 'Yes: it changes or improves what the assistant should do for this request.',
      false: 'No: it is about something else, and bringing it up would be odd.'
    })
  })
  const answers = await jev.ask('recall', { request }, questions)
  if (!answers) {
    // Jev unreachable: the strict local bar, same as having no Jev.
    return shortlist.filter((s) => s.score >= 2).slice(0, limit).map((s) => ({ memory: s.m, why: 'shares words (Jev unavailable)' }))
  }
  return shortlist
    .map((s, i) => ({ s, p: (answers[`m${i}`] as { noul?: number } | undefined)?.noul ?? 0 }))
    .filter(({ p }) => p > 0.6)
    .sort((a, b) => b.p - a.p)
    .slice(0, limit)
    .map(({ s, p }) => ({ memory: s.m, why: `Jev: ${(p * 100).toFixed(0)}% relevant` }))
}

/**
 * A learned default for one decision, when this request is about the same
 * kind of thing: "standup tomorrow 10am" → the calendar standups went on
 * before. Needs a shared distinctive word; a topic alone is not enough.
 */
export function suggestChoice(decision: string, text: string, memories: Memory[], allowed?: string[]): Memory | null {
  const w = new Set(words(text))
  const hits = memories
    .filter((m) => m.choice?.decision === decision && (!allowed || allowed.includes(m.choice.value)))
    .map((m) => ({ m, hits: m.keys.filter((k) => w.has(k)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.m.evidence - a.m.evidence || b.m.updatedAt - a.m.updatedAt)
  return hits[0]?.m ?? null
}

/** A learned choice: "Standup goes on the Work calendar." */
export function learnedChoice(decision: string, value: string, about: string, sentence: string): Memory | null {
  const keys = words(about)
  if (keys.length === 0 || looksSecret(about)) return null
  return makeMemory(sentence, 'choice', 'learned', { keys, choice: { decision, value } })
}

/** How the planner is told what is remembered: data, clearly labelled, with ids to cite. */
export function memoryNote(recalled: Recalled[]): string | null {
  if (recalled.length === 0) return null
  const lines = recalled.map((r) => `- [${r.memory.id}] ${r.memory.text}`).join('\n')
  return (
    `Things you know about the user, chosen because they look relevant to this request:\n<memory>\n${lines}\n</memory>\n` +
    `Use them where they genuinely help, as defaults the user can overrule. If one does not matter to this request, ignore it ` +
    `and do not mention it. When you rely on one, list its id in finish's usedMemories.`
  )
}
