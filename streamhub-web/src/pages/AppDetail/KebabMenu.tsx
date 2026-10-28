/**
 * Small "kebab" (⋯) overflow menu for a table row's secondary actions.
 *
 * Groups the many per-stream actions (record, restream, moderation, tags, …)
 * behind one trigger so the row keeps just its 1-2 primary actions inline.
 * Follows the same inline-popover + outside-click-close pattern as
 * {@link ShareMenu} (no portal). Clicking anywhere inside the panel closes it,
 * so an action that fires a mutation or opens a modal collapses the menu too.
 *
 * Children are the action controls (the tab's existing <Button>s), stacked
 * full-width. Rendering them as-is keeps every button's own logic (disabled
 * state, confirm dialogs, pending labels) untouched.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui'

export function KebabMenu({
  children,
  label,
}: {
  children: ReactNode
  /** Accessible name for the trigger (falls back to a generic "More"). */
  label?: string
}) {
  const { t } = useTranslation('streamsTab')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside click (simple inline popover — no portal).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={rootRef} className="relative inline-block">
      <Button
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label ?? t('actions.more')}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden className="px-0.5 text-base leading-none">
          ⋯
        </span>
      </Button>
      {open && (
        <div
          role="menu"
          aria-label={label ?? t('actions.more')}
          onClick={() => setOpen(false)}
          className="absolute right-0 z-20 mt-1 flex w-52 flex-col gap-1 rounded-lg border p-2 text-left shadow-lg border-gray-600 bg-gray-800"
        >
          {children}
        </div>
      )}
    </div>
  )
}
