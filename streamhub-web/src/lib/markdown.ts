/**
 * A deliberately small, SAFE markdown parser for the in-app changelog.
 *
 * It produces a plain AST that <Markdown/> renders as React elements — there
 * is no HTML string anywhere, so nothing in the markdown (raw `<script>`,
 * `<img onerror>`, …) can reach the DOM as markup: it is rendered as text.
 * Links are kept only for http(s), mailto and relative targets; anything else
 * (`javascript:`, `data:`) degrades to its label text.
 *
 * Supported (what CHANGELOG.md uses): ATX headings, paragraphs, bullet and
 * numbered lists nested by indentation, fenced code blocks, horizontal rules,
 * and inline strong, emphasis, code spans and [links](url).
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }

export type ListItem = { c: Inline[]; children: Block[] }

export type Block =
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'para'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'hr' }

/** True for link targets we are willing to render as an <a href>. */
export function isSafeHref(href: string): boolean {
  const h = href.trim()
  if (/^(https?:|mailto:)/i.test(h)) return true
  // relative / anchor targets; reject any other scheme ("javascript:" etc.)
  return !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith('//')
}

/** Parse inline markdown into a flat-ish AST (no HTML ever). */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf })
    buf = ''
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    // escaped char
    if (ch === '\\' && i + 1 < src.length && /[\\`*_[\]()#+\-.!>]/.test(src[i + 1])) {
      buf += src[i + 1]
      i += 2
      continue
    }
    // `code` (also ``code``)
    if (ch === '`') {
      const ticks = src.slice(i).match(/^`+/)![0]
      const end = src.indexOf(ticks, i + ticks.length)
      if (end > -1) {
        flush()
        out.push({ t: 'code', v: src.slice(i + ticks.length, end).trim() })
        i = end + ticks.length
        continue
      }
    }
    // **strong** / __strong__
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const mark = ch + ch
      const end = src.indexOf(mark, i + 2)
      if (end > i + 2) {
        flush()
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    // *em* / _em_ (an underscore inside a word, e.g. snake_case, is literal)
    if ((ch === '*' || ch === '_') && src[i + 1] !== ' ' && !(ch === '_' && /\w/.test(src[i - 1] ?? ''))) {
      let end = src.indexOf(ch, i + 1)
      while (end > -1 && ch === '_' && /\w/.test(src[end + 1] ?? '')) end = src.indexOf(ch, end + 1)
      if (end > i + 1 && src[end - 1] !== ' ') {
        flush()
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    // [label](href)
    if (ch === '[') {
      const m = src.slice(i).match(/^\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/)
      if (m) {
        flush()
        const label = parseInline(m[1])
        if (isSafeHref(m[2])) out.push({ t: 'link', href: m[2], c: label })
        else out.push(...label)
        i += m[0].length
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

/** Parse a markdown document into blocks. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  return parseBlocks(lines)
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++ // closing fence (or EOF)
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') })
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (h) {
      blocks.push({ t: 'heading', level: h[1].length, c: parseInline(h[2]) })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    if (LIST_RE.test(line)) {
      const [list, next] = parseList(lines, i)
      blocks.push(list)
      i = next
      continue
    }
    // paragraph: until blank line / heading / list / fence
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !/^\s*(```|~~~)/.test(lines[i])
    ) {
      para.push(lines[i].trim())
      i++
    }
    blocks.push({ t: 'para', c: parseInline(para.join(' ')) })
  }
  return blocks
}

function indentOf(s: string): number {
  return s.match(/^\s*/)![0].replace(/\t/g, '    ').length
}

function parseList(lines: string[], start: number): [Block, number] {
  const first = lines[start].match(LIST_RE)!
  const base = indentOf(first[1])
  const ordered = /\d/.test(first[2])
  const items: ListItem[] = []
  const nextNonBlank = (from: number) => {
    let j = from
    while (j < lines.length && !lines[j].trim()) j++
    return j
  }
  let i = start
  while (i < lines.length) {
    const m = lines[i].match(LIST_RE)
    if (!m || indentOf(lines[i]) !== base) break
    const text: string[] = [m[3]]
    const childLines: string[] = []
    i++
    while (i < lines.length) {
      const l = lines[i]
      if (!l.trim()) {
        // a blank line ends the item unless deeper content follows it
        const j = nextNonBlank(i)
        if (j < lines.length && indentOf(lines[j]) > base) {
          childLines.push('')
          i++
          continue
        }
        break
      }
      const isMarker = LIST_RE.test(l)
      if (indentOf(l) <= base) {
        // sibling / outer item, or a new block → the item ends
        if (isMarker || childLines.length || /^\s*(#{1,6}\s|```|~~~)/.test(l)) break
        text.push(l.trim()) // lazy continuation line
      } else if (!isMarker && !childLines.length) {
        text.push(l.trim()) // indented continuation of the item text
      } else {
        childLines.push(l) // nested list / block
      }
      i++
    }
    items.push({ c: parseInline(text.join(' ')), children: childLines.length ? parseBlocks(childLines) : [] })
    // blank lines between items of the same list don't end it
    const j = nextNonBlank(i)
    if (j > i && j < lines.length && LIST_RE.test(lines[j]) && indentOf(lines[j]) === base) i = j
  }
  return [{ t: 'list', ordered, items }, i]
}

/** Plain text of an inline run (for titles, search, aria labels). */
export function inlineText(c: Inline[]): string {
  return c.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : inlineText(n.c))).join('')
}
