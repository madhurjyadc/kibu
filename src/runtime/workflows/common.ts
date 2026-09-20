import { basename, extname } from 'node:path'
import type { WorkflowContext } from './types.js'

export interface FileEntry {
  path: string
  name: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifiedAt: number
  ext: string
}

/** Extension families used to propose type-based groups without a model. */
export const TYPE_FAMILIES: { group: string; exts: string[]; description: string }[] = [
  { group: 'Documents', exts: ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.pages', '.md'], description: 'Text documents, PDFs and word processor files.' },
  { group: 'Images', exts: ['.png', '.jpg', '.jpeg', '.gif', '.heic', '.webp', '.svg', '.tiff'], description: 'Photos, screenshots and other images.' },
  { group: 'Spreadsheets', exts: ['.xlsx', '.xls', '.csv', '.numbers', '.tsv'], description: 'Spreadsheets and tabular data.' },
  { group: 'Presentations', exts: ['.ppt', '.pptx', '.key'], description: 'Slide decks and presentations.' },
  { group: 'Archives', exts: ['.zip', '.tar', '.gz', '.rar', '.7z', '.dmg'], description: 'Compressed archives and disk images.' },
  { group: 'Audio', exts: ['.mp3', '.wav', '.m4a', '.aac', '.flac'], description: 'Music, recordings and other audio.' },
  { group: 'Video', exts: ['.mp4', '.mov', '.avi', '.mkv', '.webm'], description: 'Video files and screen recordings.' },
  { group: 'Installers', exts: ['.pkg', '.app', '.deb', '.exe', '.msi'], description: 'Application installers and packages.' },
  { group: 'Code', exts: ['.js', '.ts', '.py', '.rb', '.go', '.rs', '.json', '.html', '.css', '.sh'], description: 'Source code and configuration files.' }
]

export function typeGroupFor(ext: string): string | null {
  const lower = ext.toLowerCase()
  return TYPE_FAMILIES.find((f) => f.exts.includes(lower))?.group ?? null
}

/** Words too generic to make a useful project folder name. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'copy', 'final', 'draft', 'new', 'old', 'untitled',
  'document', 'file', 'image', 'photo', 'download', 'downloads', 'version', 'temp', 'test',
  'screen', 'shot', 'screenshot', 'img', 'dsc', 'pdf', 'doc', 'docx', 'png', 'jpg'
])

/**
 * Derives candidate project names from filenames, with no model involved: a
 * token that appears across several files is usually a real project or client.
 */
export function candidateProjectGroups(files: FileEntry[], minFiles = 2, max = 6): string[] {
  const counts = new Map<string, number>()
  for (const f of files) {
    const stem = basename(f.name, extname(f.name)).toLowerCase()
    const tokens = stem.split(/[^a-z0-9]+/i).filter(Boolean)
    for (const token of new Set(tokens)) {
      if (token.length < 3 || token.length > 24) continue
      if (STOPWORDS.has(token)) continue
      if (/^\d+$/.test(token)) continue
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minFiles)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([token]) => token.charAt(0).toUpperCase() + token.slice(1))
}

/** Month folders like "2026-09", derived from modification dates. */
export function candidateDateGroups(files: FileEntry[]): string[] {
  const months = new Set<string>()
  for (const f of files) months.add(new Date(f.modifiedAt).toISOString().slice(0, 7))
  return [...months].sort().reverse().slice(0, 8)
}

export function dateGroupFor(modifiedAt: number): string {
  return new Date(modifiedAt).toISOString().slice(0, 7)
}

/** Lists a folder through the tool layer, so authorization still applies. */
export async function listFolder(ctx: WorkflowContext, path: string): Promise<FileEntry[] | null> {
  const res = await ctx.run('files_list', { path, includeHidden: false })
  if (!res.ok) {
    ctx.log('warn', `could not list ${path}: ${res.error}`)
    return null
  }
  return (res.result as { entries: FileEntry[] }).entries
}

/** Reads a noul answer as a yes/no. */
export function isYes(answer: { noul: number } | undefined, threshold = 0.5): boolean {
  return !!answer && answer.noul > threshold
}
