import { choice, noul, type Jev } from './jev.js'

/**
 * One structured reading of what the user asked for.
 *
 * Everything Kibu needs to decide — what kind of work this is, what sort of
 * thing it concerns, where, when, how big — in a single shape, produced once
 * per request.
 *
 * The reason this exists: understanding used to be a dozen regexes scattered
 * across routing, the find workflow and the command workflow. Every word that
 * was not in a list was a bug — "movie" matched and "movies" did not, "watch"
 * sat in the web list and hijacked every request about films. Lists of words
 * cannot be completed, only extended after each failure.
 *
 * Jev is exactly the right instrument for this and was barely being used: it
 * cannot write text, but it maps a messy sentence onto declared alternatives
 * in one round trip. So local rules now keep only the cases they are actually
 * certain about, and everything else is one Jev call that answers every
 * question at once — roughly 450ms, a fraction of a cent, and no vocabulary
 * to maintain.
 */

export type Action = 'find' | 'organize' | 'rename' | 'make' | 'open' | 'run' | 'web' | 'app' | 'other'
export type Kind = 'any' | 'video' | 'image' | 'audio' | 'document' | 'spreadsheet' | 'slides' | 'archive' | 'code'
export type Size = 'any' | 'big' | 'huge'
export type When = 'any' | 'today' | 'week' | 'month'
export type Place = 'anywhere' | 'downloads' | 'desktop' | 'documents' | 'pictures' | 'movies' | 'music'

export interface Understanding {
  action: Action
  kind: Kind
  size: Size
  when: When
  place: Place
  /** True when the request cannot be acted on without asking something. */
  vague: boolean
  confidence: number
  source: 'local' | 'jev'
}

const ACTIONS: Record<Action, string> = {
  find: 'Locate something already on this computer and show the user where it is.',
  organize: 'Tidy a folder by sorting what is in it into groups.',
  rename: 'Give a group of files consistent names.',
  make: 'Create a new folder or file.',
  open: 'Open something in an application.',
  run: 'Run a specific command the user has dictated.',
  web: 'Visit a website, search the web, or do something in a browser.',
  app: 'Read or control a native Mac application that is already open.',
  other: 'None of these; this needs general-purpose planning.'
}

const KINDS: Record<Kind, string> = {
  any: 'No particular kind of file was implied.',
  video: 'Films, movies, clips, recordings — anything you watch.',
  image: 'Photos, pictures, screenshots, artwork.',
  audio: 'Music, songs, recordings, podcasts — anything you listen to.',
  document: 'Text documents, PDFs, notes, letters, reports.',
  spreadsheet: 'Spreadsheets, tables, CSVs, financial records.',
  slides: 'Presentations and slide decks.',
  archive: 'Zips, disk images and other bundles.',
  code: 'Source code and project files.'
}

const SIZES: Record<Size, string> = {
  any: 'Size was not mentioned.',
  big: 'The user asked for large files, or for what is taking up space.',
  huge: 'The user emphasised very large files specifically.'
}

const WHENS: Record<When, string> = {
  any: 'No time was mentioned.',
  today: 'Today, this morning, or just now.',
  week: 'Yesterday, or within roughly the past week.',
  month: 'Within roughly the past month.'
}

const PLACES: Record<Place, string> = {
  anywhere: 'No particular folder was named; search everywhere sensible.',
  downloads: 'The Downloads folder.',
  desktop: 'The Desktop.',
  documents: 'The Documents folder.',
  pictures: 'The Pictures folder.',
  movies: 'The Movies folder.',
  music: 'The Music folder.'
}

/**
 * Reads the request.
 *
 * Local rules answer only when they are genuinely certain — a dictated
 * command, files dropped on the pet. Everything else goes to Jev, because a
 * confident regex is exactly how the old version got "movies" wrong.
 */
export async function understand(
  request: string,
  jev: Jev,
  hasDroppedPaths: boolean
): Promise<Understanding> {
  const certain = readLocally(request, hasDroppedPaths)
  if (certain) return certain

  const answers = await jev.ask(
    'understand',
    { userRequest: request, filesDroppedOntoAssistant: hasDroppedPaths, today: new Date().toDateString() },
    {
      action: choice('What is the user asking to have done?', ACTIONS),
      kind: choice('What sort of thing does the request concern?', KINDS),
      size: choice('Did the user say anything about how large the files are?', SIZES),
      when: choice('Did the user say anything about when?', WHENS),
      place: choice('Did the user name a particular folder?', PLACES),
      vague: noul('Is this too vague to act on without asking the user what they mean?', {
        true: 'A reasonable assistant would have to ask before starting.',
        false: 'There is a clear, sensible first step.'
      })
    }
  )

  if (!answers) return fallback(request, hasDroppedPaths)

  // Never trust the shape of a reply that came over a network. A missing or
  // unexpected answer falls back to local rules rather than throwing a
  // TypeError in the middle of the user's task.
  const base = fallback(request, hasDroppedPaths)
  const pick = <T extends string>(answer: unknown, allowed: Record<T, string>, ifMissing: T): T => {
    const value = (answer as { choice?: unknown } | undefined)?.choice
    return typeof value === 'string' && value in allowed ? (value as T) : ifMissing
  }
  const probability = (answer: unknown, ifMissing: boolean): boolean => {
    const value = (answer as { noul?: unknown } | undefined)?.noul
    return typeof value === 'number' ? value > 0.5 : ifMissing
  }
  const confidence = (answers.action as { confidence?: unknown } | undefined)?.confidence

  return {
    action: pick(answers.action, ACTIONS, base.action),
    kind: pick(answers.kind, KINDS, base.kind),
    size: pick(answers.size, SIZES, base.size),
    when: pick(answers.when, WHENS, base.when),
    place: pick(answers.place, PLACES, base.place),
    vague: probability(answers.vague, base.vague),
    confidence: typeof confidence === 'number' ? confidence : 0.5,
    source: typeof (answers.action as { choice?: unknown } | undefined)?.choice === 'string' ? 'jev' : 'local'
  }
}

/** Root words that identify each kind, matched with plurals folded in. */
const KIND_WORDS: Record<Exclude<Kind, 'any'>, string[]> = {
  video: ['movie', 'film', 'video', 'clip', 'episode', 'series', 'recording', 'mp4', 'mkv'],
  image: ['photo', 'picture', 'image', 'screenshot', 'screengrab', 'wallpaper', 'png', 'jpg', 'jpeg'],
  audio: ['song', 'music', 'audio', 'track', 'album', 'podcast', 'mp3'],
  document: ['document', 'doc', 'pdf', 'note', 'letter', 'report', 'essay', 'book', 'invoice', 'receipt', 'card'],
  spreadsheet: ['spreadsheet', 'sheet', 'excel', 'csv', 'table'],
  slides: ['slide', 'deck', 'presentation', 'powerpoint', 'keynote'],
  archive: ['zip', 'archive', 'dmg', 'installer', 'tarball'],
  code: ['code', 'script', 'repo', 'project', 'source']
}

const SIZE_WORDS: Record<Exclude<Size, 'any'>, string[]> = {
  huge: ['huge', 'massive', 'enormous', 'gigantic'],
  big: ['big', 'large', 'biggest', 'largest', 'heavy', 'space', 'storage', 'bulky', 'hogging']
}

const WHEN_WORDS: Record<Exclude<When, 'any'>, string[]> = {
  today: ['today', 'morning', 'now'],
  week: ['yesterday', 'week', 'recent', 'recently', 'latest', 'lately'],
  month: ['month']
}

const PLACE_WORDS: Record<Exclude<Place, 'anywhere'>, string[]> = {
  downloads: ['download', 'downloaded', 'downloads'],
  desktop: ['desktop'],
  documents: ['documents'],
  pictures: ['pictures'],
  movies: [],
  music: []
}

const ACTION_WORDS: Partial<Record<Action, string[]>> = {
  find: ['find', 'locate', 'search', 'where', 'show', 'look'],
  organize: ['organise', 'organize', 'tidy', 'sort', 'clean', 'declutter'],
  rename: ['rename', 'naming'],
  make: ['create', 'make', 'mkdir'],
  open: ['open', 'launch'],
  web: ['browse', 'google', 'youtube', 'website', 'web']
}

/**
 * Folds a request into the word stems it contains.
 *
 * Plurals were a whole class of bug on their own: "movie" was listed and
 * "movies" was not, so asking for movies searched for the literal word. One
 * fold here removes the need to list every form of every word.
 */
function stems(request: string): Set<string> {
  const out = new Set<string>()
  for (const raw of request.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue
    out.add(raw)
    if (raw.endsWith('ies')) out.add(`${raw.slice(0, -3)}y`)
    if (raw.endsWith('es')) out.add(raw.slice(0, -2))
    if (raw.endsWith('s')) out.add(raw.slice(0, -1))
  }
  return out
}

function firstMatch<T extends string>(words: Set<string>, table: Record<T, string[]>): T | null {
  for (const [key, list] of Object.entries(table) as [T, string[]][]) {
    if (list.some((w) => words.has(w))) return key
  }
  return null
}

/**
 * What local code may claim without asking Jev.
 *
 * The bar is "certain", not "plausible". A clear action verb plus attributes
 * that map cleanly onto the vocabularies is answerable here for nothing; a
 * request with no recognisable verb — "any movies to watch?" — is exactly the
 * ambiguity Jev exists for, and is not guessed at.
 */
function readLocally(request: string, hasDroppedPaths: boolean): Understanding | null {
  if (/^\s*(?:run|execute|exec)\s+\S+/i.test(request)) {
    return { ...BLANK, action: 'run', confidence: 0.95 }
  }
  // A URL is not open to interpretation.
  if (/\bhttps?:\/\/\S+/i.test(request)) {
    return { ...BLANK, action: 'web', confidence: 0.95 }
  }

  const words = stems(request)

  // Naming a site, or anything host-shaped, settles it. "open youtube and
  // search for a good video" contains both "open" and "search", and picking
  // whichever verb came first in a list is how this ended up searching the
  // Downloads folder for a YouTube video.
  if (isWeb(request, words)) return { ...BLANK, action: 'web', confidence: 0.9 }

  const matched = (Object.entries(ACTION_WORDS) as [Action, string[]][])
    .filter(([, list]) => list.some((w) => words.has(w)))
    .map(([key]) => key)

  let action: Action | null = null
  if (matched.length === 1) action = matched[0]!
  // "make a folder and open it in Zed" is one job, not two competing ones.
  else if (matched.length > 1 && matched.every((a) => a === 'make' || a === 'open' || a === 'run')) {
    action = matched.includes('make') ? 'make' : matched.includes('open') ? 'open' : 'run'
  }

  if (!action) {
    // Files put in front of Kibu with a short instruction are unambiguous.
    if (hasDroppedPaths && request.trim().split(/\s+/).length < 5) {
      return { ...BLANK, action: 'organize', confidence: 0.9 }
    }
    // Two verbs pulling different ways, or none at all: ask Jev rather than
    // pick one and be confidently wrong.
    return null
  }

  return {
    action,
    kind: firstMatch(words, KIND_WORDS as Record<Kind, string[]>) ?? 'any',
    size: firstMatch(words, SIZE_WORDS as Record<Size, string[]>) ?? 'any',
    when: firstMatch(words, WHEN_WORDS as Record<When, string[]>) ?? 'any',
    place: firstMatch(words, PLACE_WORDS as Record<Place, string[]>) ?? 'anywhere',
    vague: false,
    confidence: 0.85,
    source: 'local'
  }
}

/**
 * Whether this is plainly about the web.
 *
 * A shape rule, not a list of sites: listing top-level domains is a losing
 * game, and "bunkr.cr" is as real as "youtube.com". Filenames are excluded,
 * because "report.pdf" is host-shaped and is obviously not a website.
 */
function isWeb(request: string, words: Set<string>): boolean {
  const r = request.toLowerCase()
  const named = ['youtube', 'netflix', 'gmail', 'google', 'twitter', 'reddit', 'amazon', 'instagram',
    'facebook', 'spotify', 'wikipedia', 'github', 'linkedin', 'chatgpt']
  if (named.some((site) => words.has(site))) return true
  if (/\b(web|internet|online|browser|website)\b/.test(r)) return true
  return (
    /\b[a-z0-9][a-z0-9-]{1,}\.[a-z]{2,6}\b/.test(r) &&
    !/\.(pdf|png|jpe?g|gif|mp4|mov|mkv|mp3|docx?|xlsx?|pptx?|txt|csv|zip|dmg|heic|webp|md|json|ts|js|py)\b/.test(r)
  )
}

const BLANK = {
  kind: 'any',
  size: 'any',
  when: 'any',
  place: 'anywhere',
  vague: false,
  source: 'local'
} as const

/**
 * When Jev is unavailable.
 *
 * Coarser than the confident path — it will guess an action where the
 * confident path refuses to — but it reads the same vocabularies rather than
 * keeping a second set of words that drift apart from the first. Two lists
 * meaning the same thing is how "storage" counted as a size in one place and
 * not in the other.
 */
function fallback(request: string, hasDroppedPaths: boolean): Understanding {
  const words = stems(request)
  const action =
    firstMatch(words, ACTION_WORDS as Record<Action, string[]>) ?? (hasDroppedPaths ? 'organize' : 'other')
  return {
    action,
    kind: firstMatch(words, KIND_WORDS as Record<Kind, string[]>) ?? 'any',
    size: firstMatch(words, SIZE_WORDS as Record<Size, string[]>) ?? 'any',
    when: firstMatch(words, WHEN_WORDS as Record<When, string[]>) ?? 'any',
    place: firstMatch(words, PLACE_WORDS as Record<Place, string[]>) ?? 'anywhere',
    vague: action === 'other',
    confidence: 0.4,
    source: 'local'
  }
}

/** File extensions for a kind, for filtering a search. */
export function extensionsFor(kind: Kind): string[] {
  switch (kind) {
    case 'video':
      return ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.wmv', '.flv']
    case 'image':
      return ['.png', '.jpg', '.jpeg', '.heic', '.gif', '.webp', '.tiff', '.bmp', '.svg']
    case 'audio':
      return ['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.aiff']
    case 'document':
      return ['.pdf', '.docx', '.doc', '.pages', '.txt', '.md', '.rtf', '.epub']
    case 'spreadsheet':
      return ['.xlsx', '.xls', '.csv', '.numbers', '.tsv']
    case 'slides':
      return ['.pptx', '.ppt', '.key']
    case 'archive':
      return ['.zip', '.tar', '.gz', '.dmg', '.7z', '.rar', '.iso']
    case 'code':
      return ['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.swift', '.rb']
    default:
      return []
  }
}

/** The smallest size, in bytes, that counts as what the user asked for. */
export function bytesFor(size: Size): number | null {
  switch (size) {
    case 'big':
      return 100 * 1024 * 1024
    case 'huge':
      return 1024 * 1024 * 1024
    default:
      return null
  }
}

/** Milliseconds of history a timeframe covers. */
export function sinceFor(when: When): number | null {
  const day = 86_400_000
  switch (when) {
    case 'today':
      return day
    case 'week':
      return 8 * day
    case 'month':
      return 31 * day
    default:
      return null
  }
}

/** Which folder a place means, relative to home. */
export function folderFor(place: Place): string | null {
  switch (place) {
    case 'downloads':
      return 'Downloads'
    case 'desktop':
      return 'Desktop'
    case 'documents':
      return 'Documents'
    case 'pictures':
      return 'Pictures'
    case 'movies':
      return 'Movies'
    case 'music':
      return 'Music'
    default:
      return null
  }
}

/**
 * Which toolset a reading implies.
 *
 * Derived rather than asked separately: the action already says what kind of
 * work this is, so a second routing question would be the same judgment
 * bought twice.
 */
export function routeFor(read: Understanding): { route: string; reason: string; needsClarification: boolean } {
  const route =
    read.action === 'web'
      ? 'browser'
      : read.action === 'app'
        ? 'desktop'
        : read.action === 'other'
          ? 'unclear'
          : 'files'
  return {
    route,
    reason: `read as "${read.action}" (${read.source})`,
    needsClarification: read.vague
  }
}

/** A neutral reading, for the paths that never ran understand(). */
export function fallbackUnderstanding(): Understanding {
  return {
    action: 'other',
    kind: 'any',
    size: 'any',
    when: 'any',
    place: 'anywhere',
    vague: false,
    confidence: 0,
    source: 'local'
  }
}
