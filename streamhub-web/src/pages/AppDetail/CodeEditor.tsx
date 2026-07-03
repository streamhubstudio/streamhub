/**
 * Minimal monospace code editor with a simple line-number gutter.
 * Used by the raw config.yaml editor (ConfigTab) and the per-app HTML sample
 * editor (SamplesManager). Intentionally dependency-free — no syntax highlight,
 * just numbered lines + a scroll-synced gutter.
 *
 * Owned by the AppDetail agent — do not import outside this page.
 */
import { useRef } from 'react'

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  rows = 18,
  ariaLabel,
}: {
  value: string
  onChange?: (v: string) => void
  readOnly?: boolean
  /** Minimum visible rows (the gutter never shows fewer lines than this). */
  rows?: number
  ariaLabel?: string
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)

  const lineCount = Math.max(value.split('\n').length, rows)
  const numbers = Array.from({ length: lineCount }, (_, i) => i + 1)

  function syncScroll() {
    if (gutterRef.current && taRef.current) {
      gutterRef.current.scrollTop = taRef.current.scrollTop
    }
  }

  return (
    <div className="flex max-h-[60vh] overflow-hidden rounded-lg border border-navy-600 bg-navy-900/60 font-mono text-xs">
      <div
        ref={gutterRef}
        aria-hidden="true"
        className="select-none overflow-hidden border-r border-navy-600 bg-navy-800/60 px-2 py-2 text-right text-slate-600"
        style={{ minWidth: '2.75rem' }}
      >
        {numbers.map((n) => (
          <div key={n} className="leading-5">
            {n}
          </div>
        ))}
      </div>
      <textarea
        ref={taRef}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        wrap="off"
        aria-label={ariaLabel}
        rows={rows}
        onScroll={syncScroll}
        onChange={(e) => onChange?.(e.target.value)}
        className="block w-full resize-y overflow-auto bg-transparent px-3 py-2 leading-5 text-slate-100 outline-none placeholder:text-slate-600"
        style={{ tabSize: 2 }}
      />
    </div>
  )
}
