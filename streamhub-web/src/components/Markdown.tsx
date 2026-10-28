/**
 * Renders the safe markdown AST from `@/lib/markdown` as React elements.
 * No `dangerouslySetInnerHTML`: every string is a React text node, so any HTML
 * inside the markdown shows up as literal text. Links open in a new tab with
 * `noopener noreferrer`, and only hrefs that passed `isSafeHref` exist here.
 */
import { Fragment, useMemo } from 'react'
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown'

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <Fragment key={i}>{n.v}</Fragment>
          case 'code':
            return (
              <code key={i} className="rounded-chip bg-surface-raised px-1 py-px text-[0.9em] text-slate-200">
                {n.v}
              </code>
            )
          case 'strong':
            return (
              <strong key={i} className="font-semibold text-fg">
                <Inlines nodes={n.c} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <Inlines nodes={n.c} />
              </em>
            )
          case 'link':
            return (
              <a
                key={i}
                href={n.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-400 underline decoration-primary-400/40 underline-offset-2 hover:decoration-primary-400"
              >
                <Inlines nodes={n.c} />
              </a>
            )
        }
      })}
    </>
  )
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'heading': {
            // Release sections render under their own <h3>; body headings
            // ("### Changed", "### Fixed") step down from there.
            const Tag = b.level <= 3 ? 'h4' : 'h5'
            return (
              <Tag key={i} className="mt-4 mb-1.5 text-sm font-semibold text-fg first:mt-0">
                <Inlines nodes={b.c} />
              </Tag>
            )
          }
          case 'para':
            return (
              <p key={i} className="my-2 text-fg-muted">
                <Inlines nodes={b.c} />
              </p>
            )
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul'
            return (
              <Tag
                key={i}
                className={`my-2 space-y-1.5 pl-5 text-fg-muted ${b.ordered ? 'list-decimal' : 'list-disc marker:text-fg-subtle'}`}
              >
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inlines nodes={it.c} />
                    {it.children.length > 0 && <Blocks blocks={it.children} />}
                  </li>
                ))}
              </Tag>
            )
          }
          case 'code':
            return (
              <pre
                key={i}
                className="my-2 overflow-x-auto rounded-control border border-border bg-surface-sunken p-3 text-xs text-slate-200"
              >
                <code>{b.v}</code>
              </pre>
            )
          case 'hr':
            return <hr key={i} className="my-4 border-border" />
        }
      })}
    </>
  )
}

export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className={`text-sm leading-relaxed ${className}`}>
      <Blocks blocks={blocks} />
    </div>
  )
}
