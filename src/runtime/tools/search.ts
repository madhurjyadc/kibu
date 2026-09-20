import { documentTerms, removeDocumentWords } from '../search-language.js'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, isAbsolute } from 'node:path'
import { readdir, stat, realpath } from 'node:fs/promises'
import { isForbidden, normalizePath } from '../authorization.js'
import type { ToolDefinition } from './registry.js'

/**
 * Finding a file the user half-remembers.
 *
 * The old implementation walked directories and never matched on the words
 * the user actually typed — it fetched every recent file of a type and sorted
 * by date, which is not a search. This asks Spotlight's index instead: the
 * same index the Finder uses, already built, covering filenames *and* file
 * contents, and it answers across a whole home directory in about 200ms.
 *
 * It needs no authorization prompt because it cannot change anything and
 * never returns file contents — only paths and their metadata, for locations
 * the user can already see in their own Finder. Opening one of the results is
 * a separate, explicit act.
 */

/** Places whose contents are noise in a search for the user's own documents. */
const NOISE = [
  '/Library/',
  '/node_modules/',
  '/.git/',
  '/.Trash/',
  '/Applications/',
  '/.cache/',
  '/Caches/',
  '/DerivedData/',
  '/.npm/',
  '/.cargo/'
]

export interface FoundFile {
  path: string
  name: string
  folder: string
  modifiedAt: number
  size: number
  score: number
  why: string
}

export const filesFind: ToolDefinition = {
  name: 'files_find',
  description:
    "Find files the user is describing from memory, by name and by what is inside them, anywhere in their home folder. Uses the macOS Spotlight index, so it is fast and covers file contents. Prefer this over files_search whenever you are looking for something rather than listing a known folder.",
  capability: 'files.read',
  input: z.object({
    terms: z.string().describe('The distinctive words to look for, e.g. "ethernet frames" — not the whole sentence'),
    extensions: z.array(z.string()).optional().describe('Restrict to these extensions, e.g. [".pdf"]'),
    modifiedAfter: z.number().optional().describe('Unix ms; only files changed since then'),
    folder: z.string().optional().describe('Restrict to one folder. Omit to search the whole home folder.'),
    limit: z.number().int().min(1).max(50).default(12)
  }),
  // Reading a path list changes nothing and reveals nothing the user cannot
  // already see in their own Finder, so this asks for no new authorization.
  scopes: () => [],
  async execute(i, ctx) {
    const root = i.folder ? normalizePath(i.folder) : homedir()
    const results = await findFiles({
      terms: i.terms,
      root,
      ...(i.extensions ? { extensions: i.extensions } : {}),
      ...(i.modifiedAfter ? { modifiedAfter: i.modifiedAfter } : {}),
      limit: i.limit
    })
    ctx.observe({
      kind: 'files',
      summary: `Searched for "${i.terms}" in ${root === homedir() ? 'your home folder' : basename(root)}: ${results.length} matches`,
      data: { terms: i.terms, count: results.length },
      staleAfterMs: 60_000
    })
    return { result: { matches: results } }
  }
}

function nameHits(path: string, words: string[]): number {
  const name = searchableName(path)
  return words.filter((w) => name.includes(w)).length
}

export interface FindOptions {
  terms: string
  /** Pre-parsed terms, when the caller has already read the sentence. */
  words?: string[]
  root: string
  extensions?: string[]
  modifiedAfter?: number
  limit: number
}

export async function findFiles(opts: FindOptions): Promise<FoundFile[]> {
  const root = await realpath(opts.root).catch(() => opts.root)
  if (isForbidden(root)) return []
  const rootInfo = await stat(root).catch(() => null)
  if (!rootInfo) return []
  const concepts = documentTerms(opts.terms)
  const words = opts.words ?? distinctiveWords(removeDocumentWords(opts.terms))
  const terms = [...new Set([...words, ...concepts])]
  const query = buildQuery(terms, opts.extensions, opts.modifiedAfter, concepts)
  const args = ['-onlyin', root]
  args.push(query ?? 'kMDItemFSName == "*"c')

  const exts = opts.extensions?.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase())
  const eligible = (path: string): boolean => {
    const rel = relative(root, path)
    return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
      && !isForbidden(path) && !NOISE.some((n) => path.includes(n))
      && (!exts?.length || exts.some((ext) => path.toLowerCase().endsWith(ext)))
  }
  const indexed = rootInfo.isFile() ? [] : (await mdfind(args)).filter(eligible)
  const indexedPaths = new Set(indexed)
  // No useful indexed hit: search filenames locally, pruning caches before they
  // consume the walk budget. A concept's content hits must not hide an unindexed ID.
  const needWalk = indexed.length === 0 || (concepts.length > 0 && !indexed.some((p) => nameHits(p, concepts) > 0))
  const fallback = rootInfo.isFile() ? [root] : needWalk ? await walk(root, 6, 4000) : []
  const paths = [...new Set([...indexed, ...fallback])]
    .filter(eligible)
    // The index returns matches in no useful order, so prefer the ones whose
    // names match before spending a stat on the rest.
    .sort((a, b) => nameHits(b, concepts.length ? concepts : terms) - nameHits(a, concepts.length ? concepts : terms))
    .slice(0, 150)

  // One stat each, all at once: doing these in sequence was most of the wait.
  const stats = await Promise.all(
    paths.map(async (path) => {
      try {
        if (isForbidden(await realpath(path))) return null
        const info = await stat(path)
        return info.isDirectory() ? null : { path, mtimeMs: info.mtimeMs, size: info.size }
      } catch {
        return null // Indexed but since deleted.
      }
    })
  )

  const scored: FoundFile[] = []
  for (const entry of stats) {
    if (!entry) continue
    if (opts.modifiedAfter && entry.mtimeMs < opts.modifiedAfter) continue
    // mdfind applied these already; a fallback walk has not.
    const lower = basename(entry.path).toLowerCase()
    if (exts?.length && !exts.some((e) => lower.endsWith(e))) continue
    if (!indexedPaths.has(entry.path) && terms.length && !(concepts.length ? concepts : terms).some((w) => searchableName(entry.path).includes(w))) continue
    const { score, why } = rank(entry.path, terms, entry.mtimeMs, concepts)
    scored.push({
      path: entry.path,
      name: basename(entry.path),
      folder: dirname(entry.path),
      modifiedAt: entry.mtimeMs,
      size: entry.size,
      score,
      why
    })
  }

  scored.sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt)
  return scored.slice(0, opts.limit)
}

/**
 * Ranking, in code rather than by a model.
 *
 * A model scoring bare filenames is both slower and worse — "cls1.pdf" tells
 * it nothing. These signals are cheap, explainable, and the reason each hit
 * won is reported back so the user can see why.
 */
function rank(path: string, words: string[], modifiedMs: number, concepts: string[] = []): { score: number; why: string } {
  const name = searchableName(path)
  const stem = name.replace(/\.[^.]+$/, '')
  const reasons: string[] = []
  let score = 0

  const hit = words.filter((w) => name.includes(w))
  if (hit.length) {
    score += concepts.some((term) => name.includes(term)) ? 65 : 40 * (hit.length / words.length)
    const descriptors = words.filter((word) => !concepts.includes(word))
    if (concepts.length && descriptors.length) score += 15 * descriptors.filter((word) => name.includes(word)).length / descriptors.length
    reasons.push('Name match')
  }
  if (words.length && stem === words.join(' ')) {
    score += 25
    reasons.push('the name is exactly that')
  }
  // Only claim a content match when there was actually something to match.
  if (!hit.length && words.length) reasons.push('Indexed content match')

  // Recency, decaying over a month. "The one I downloaded yesterday" is the
  // overwhelmingly common case, but it must not drown out a name match.
  const days = (Date.now() - modifiedMs) / 86_400_000
  if (days < 1) {
    score += 22
    reasons.push('changed today')
  } else if (days < 7) {
    score += 14
    reasons.push(`changed ${Math.round(days)}d ago`)
  } else if (days < 31) score += 6

  // Where people keep things they are talking about.
  if (/\/(Downloads|Desktop|Documents)\//.test(path)) {
    score += 12
    reasons.push(`in ${path.split('/').slice(-2, -1)[0]}`)
  }
  if (/\/(dev|Projects|Code|src)\//.test(path)) score += 4

  return { score, why: reasons.slice(0, 3).join(' · ') }
}

/**
 * Builds an mdfind expression.
 *
 * The terms are OR-ed, not AND-ed: "the cybersecurity notes I downloaded"
 * should still find CyberSecurity.pdf even though no file is called "notes".
 * Requiring every word found nothing at all, which is the worse failure —
 * ranking sorts out which of the loose matches actually wins.
 */
function buildQuery(words: string[], extensions?: string[], modifiedAfter?: number, concepts: string[] = []): string | null {
  const clauses: string[] = []
  if (words.length) {
    const byName = (concepts.length ? concepts : words).map((w) => `kMDItemFSName == "*${escape(w)}*"cd`)
    const byContent = (concepts.length ? concepts : words).map((w) => `kMDItemTextContent == "${escape(w)}"cd`)
    clauses.push(`(${[...byName, ...byContent].join(' || ')})`)
  }
  if (extensions?.length) {
    const exts = extensions.map((e) => `kMDItemFSName == "*${escape(e.startsWith('.') ? e : `.${e}`)}"cd`)
    clauses.push(`(${exts.join(' || ')})`)
  }
  if (modifiedAfter) {
    // Filtering in the index is far cheaper than stat-ing everything it returns.
    const days = Math.max(1, Math.ceil((Date.now() - modifiedAfter) / 86_400_000))
    clauses.push(`kMDItemContentModificationDate >= $time.today(-${days})`)
  }
  return clauses.length ? clauses.join(' && ') : null
}

/** Words that name a kind of file, and the extensions they mean. */
const KINDS: { words: string[]; exts: string[] }[] = [
  { words: ['pdf'], exts: ['.pdf'] },
  { words: ['screenshot', 'screengrab'], exts: ['.png', '.jpg', '.jpeg'] },
  { words: ['image', 'images', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pics'], exts: ['.png', '.jpg', '.jpeg', '.heic', '.gif', '.webp'] },
  { words: ['video', 'videos', 'movie', 'clip'], exts: ['.mp4', '.mov', '.m4v', '.avi', '.mkv'] },
  { words: ['song', 'songs', 'music', 'audio', 'track'], exts: ['.mp3', '.m4a', '.wav', '.aac', '.flac'] },
  { words: ['doc', 'docs', 'word'], exts: ['.docx', '.doc', '.pages'] },
  { words: ['sheet', 'spreadsheet', 'excel', 'csv'], exts: ['.xlsx', '.xls', '.csv', '.numbers'] },
  { words: ['slides', 'deck', 'presentation', 'powerpoint'], exts: ['.pptx', '.ppt', '.key'] },
  { words: ['zip', 'archive'], exts: ['.zip', '.tar', '.gz', '.dmg'] }
]

const DAY = 86_400_000
const WHENS: { re: RegExp; ms: number }[] = [
  { re: /\b(today|this morning|just now|just)\b/, ms: DAY },
  { re: /\byesterday\b/, ms: 2 * DAY },
  { re: /\b(this week|last week|few days|recent|recently|latest|last one)\b/, ms: 8 * DAY },
  { re: /\b(this month|last month)\b/, ms: 31 * DAY }
]

const FOLDERS: { re: RegExp; dir: string }[] = [
  { re: /\b(downloads?|downloaded)\b/, dir: 'Downloads' },
  { re: /\bdesktop\b/, dir: 'Desktop' },
  { re: /\bdocuments?\b/, dir: 'Documents' },
  { re: /\b(pictures?|photos library)\b/, dir: 'Pictures' }
]

export interface ParsedQuery {
  words: string[]
  extensions: string[]
  modifiedAfter: number | null
  folder: string | null
  /** Nothing was named: the user wants whatever is newest. */
  recencyOnly: boolean
}

/**
 * Reads the sentence the way a person means it, in code.
 *
 * "the pdf I downloaded yesterday" is a type filter, a time filter and a
 * place — not three search words. Asking a model to work that out costs
 * hundreds of milliseconds and gets it no more right than these rules do.
 */
export function parseQuery(text: string): ParsedQuery {
  const lower = text.toLowerCase()

  const extensions: string[] = []
  const kindWords = new Set<string>()
  for (const kind of KINDS) {
    if (kind.words.some((w) => new RegExp(`\\b${w}\\b`).test(lower))) {
      extensions.push(...kind.exts)
      for (const w of kind.words) kindWords.add(w)
    }
  }

  let modifiedAfter: number | null = null
  for (const when of WHENS) {
    if (when.re.test(lower)) {
      modifiedAfter = Date.now() - when.ms
      break
    }
  }

  let folder = FOLDERS.find((f) => f.re.test(lower))?.dir ?? null

  // Anything already used as a filter is not also a search term.
  const words = distinctiveWords(removeDocumentWords(text)).filter(
    (w) => !kindWords.has(w) && !WHENS.some((x) => x.re.test(w)) && !FOLDERS.some((f) => f.re.test(w))
  )
  // "my latest downloaded file" names no file and no kind: it is a request for
  // the newest thing somewhere obvious. Sweeping the whole home by date is
  // both slow and meaningless, so it becomes a recency query over Downloads.
  words.unshift(...documentTerms(text))
  const recencyOnly = words.length === 0 && extensions.length === 0
  if (recencyOnly && !folder) folder = 'Downloads'
  if (recencyOnly && !modifiedAfter) modifiedAfter = Date.now() - 31 * DAY

  return { words, extensions, modifiedAfter, folder, recencyOnly }
}

/** Drops the words every request contains, keeping the ones that identify it. */
const STOPWORDS = new Set([
  'find','the','a','an','my','me','i','file','files','that','this','it','open','show','where','is','was','get',
  'please','can','you','for','of','in','on','from','with','about','and','or','to','last','some','thing','saved',
  'downloaded','looking','look','need','want','again','one','document','folder','pls','plz','search','locate',
  'pc','computer','mac','laptop','device','card','copy','could','would','hey','kibu','out','up','have','where','stored','dig'
])

export function distinctiveWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\p{M}\s.-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .slice(0, 6)
}

function escape(term: string): string {
  return term.replace(/(["\\])/g, '\\$1')
}

/** A bounded directory walk, for whatever the index cannot see. */
async function walk(root: string, maxDepth: number, limit: number): Promise<string[]> {
  const found: string[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || found.length >= limit) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // Unreadable directories are skipped, not fatal.
    }
    const priority = ['Downloads', 'Documents', 'Desktop', 'Pictures']
    entries.sort((a, b) => (priority.indexOf(a.name) < 0 ? 99 : priority.indexOf(a.name)) - (priority.indexOf(b.name) < 0 ? 99 : priority.indexOf(b.name)))
    for (const entry of entries) {
      if (found.length >= limit) return
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (isForbidden(full) || NOISE.some((n) => `${full}/`.includes(n)) || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(full, depth + 1)
      else found.push(full)
    }
  }
  await visit(root, 1)
  return found
}

function mdfind(args: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('/usr/bin/mdfind', args, { maxBuffer: 32 * 1024 * 1024, timeout: 2500 }, (err, stdout) => {
      // A failed index query is an empty result, not a crashed task.
      if (err && !stdout) resolve([])
      else resolve(stdout.split('\n').filter(Boolean))
    })
  })
}

function searchableName(path: string): string {
  return basename(path).normalize('NFKC').toLowerCase().replace(/[_-]+/g, ' ')
}
