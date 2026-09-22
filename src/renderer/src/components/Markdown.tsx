import type { ReactNode } from 'react'

/**
 * The small slice of Markdown models actually write in a chat answer:
 * paragraphs, bullet and numbered lists, headings, quotes, fenced code, and
 * inline bold, italic, code and links.
 *
 * It builds React elements rather than HTML, so model text can never inject
 * markup, and links open through the host's validated URL handler only.
 */

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'ul' | 'ol'; items: string[]; start: number }

/**
 * Emoji read as noise in a calm interface. A line that opens with one is
 * being used as a list item, so it becomes one; anywhere else they are
 * simply dropped.
 */
const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\u200D(?:\p{Extended_Pictographic}))*\uFE0F?/gu
const EMOJI_LEAD = /^\s*(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u
export function stripEmoji(line: string): string {
  if (EMOJI_LEAD.test(line)) line = line.replace(EMOJI_LEAD, '- ')
  return line.replace(EMOJI, '').replace(/ {2,}/g, ' ')
}

const BULLET = /^\s*[-*•]\s+(.*)$/
const NUMBER = /^\s*(\d+)[.)]\s+(.*)$/
const HEADING = /^\s*#{1,6}\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n').map(stripEmoji)
  const blocks: Block[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!)
      blocks.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const heading = HEADING.exec(line)
    if (heading) { flush(); blocks.push({ kind: 'h', text: heading[1]! }); continue }
    const quote = QUOTE.exec(line)
    if (quote) { flush(); blocks.push({ kind: 'quote', text: quote[1]! }); continue }
    const bullet = BULLET.exec(line)
    const number = NUMBER.exec(line)
    if (bullet || number) {
      flush()
      const kind = bullet ? 'ul' : 'ol'
      const last = blocks[blocks.length - 1]
      const item = (bullet ? bullet[1] : number![2])!
      if (last && last.kind === kind) last.items.push(item)
      else blocks.push({ kind, items: [item], start: number ? Number(number[1]) : 1 })
      continue
    }
    // A wrapped continuation of the previous list item.
    const last = blocks[blocks.length - 1]
    if (!para.length && last && (last.kind === 'ul' || last.kind === 'ol') && /^\s{2,}/.test(line)) {
      last.items[last.items.length - 1] += ` ${line.trim()}`
      continue
    }
    para.push(line.trim())
  }
  flush()
  return blocks
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]+[^\s).,;:!?])/g

function inline(text: string, key = ''): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    const k = `${key}-${n++}`
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k}>{inline(m[2].slice(2, -2), k)}</strong>)
    else if (m[3]) out.push(<em key={k}>{inline(m[3].slice(1, -1), k)}</em>)
    else if (m[4]) out.push(<Link key={k} href={m[5]!}>{m[4].slice(1, m[4].indexOf(']'))}</Link>)
    else if (m[6]) out.push(<Link key={k} href={m[6]}>{m[6].replace(/^https?:\/\//, '')}</Link>)
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function Link({ href, children }: { href: string; children: ReactNode }): React.JSX.Element {
  return <button className="md-link" title={href} onClick={() => void window.kibu.openUrl(href).catch(() => {})}>{children}</button>
}

/** "**Files** — find and sort things": a label and what it means. */
const TERM = /^\*\*([^*]{1,40})\*\*\s*(?:[—–:-]\s*)?(.+)$/

function Item({ text, id }: { text: string; id: string }): React.JSX.Element {
  const term = TERM.exec(text)
  if (!term) return <li>{inline(text, id)}</li>
  return <li className="md-term-item"><span className="md-term">{inline(term[1]!, `${id}t`)}</span><span className="md-def">{inline(term[2]!, `${id}d`)}</span></li>
}

export function Markdown({ text, className = '' }: { text: string; className?: string }): React.JSX.Element {
  const blocks = parseBlocks(text)
  return (
    <div className={`md ${className}`}>
      {blocks.map((b, i) => {
        const style = { ['--i' as string]: i }
        switch (b.kind) {
          case 'p': return <p key={i} style={style}>{inline(b.text, `p${i}`)}</p>
          case 'h': return <h3 key={i} style={style}>{inline(b.text, `h${i}`)}</h3>
          case 'quote': return <blockquote key={i} style={style}>{inline(b.text, `q${i}`)}</blockquote>
          case 'code': return <pre key={i} style={style}><code>{b.text}</code></pre>
          case 'ul': {
            const terms = b.items.every((it) => TERM.test(it))
            return <ul key={i} style={style} className={terms ? 'md-terms' : ''}>{b.items.map((it, j) => <Item key={j} text={it} id={`u${i}-${j}`} />)}</ul>
          }
          case 'ol': return <ol key={i} start={b.start} style={style}>{b.items.map((it, j) => <li key={j}>{inline(it, `o${i}-${j}`)}</li>)}</ol>
        }
      })}
    </div>
  )
}

/** The same text with the formatting marks removed, for one-line places like the pet's bubble. */
export function plainText(md: string): string {
  return md.split('\n').map(stripEmoji).join('\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_]/g, '$1$2')
    .replace(/^\s*(?:[-*•]|\d+[.)]|#{1,6}|>)\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
}
