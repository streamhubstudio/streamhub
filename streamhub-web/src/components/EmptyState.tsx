/**
 * Empty state — "no signal". A dashed, sunken well (nothing is patched in
 * here yet) with a muted off-air glyph, the message, and an optional action:
 * an empty screen should say what to do next, not just that it's empty.
 */
import type { ReactNode } from 'react'
import { HiOutlineStatusOffline } from 'react-icons/hi'

export function EmptyState({
  label,
  hint,
  action,
  className = '',
}: {
  label: ReactNode
  hint?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-panel border border-dashed border-border-strong bg-surface-sunken/60 px-5 py-10 text-center ${className}`}
    >
      <HiOutlineStatusOffline aria-hidden="true" className="text-2xl text-fg-subtle" />
      <p className="text-sm text-fg-muted">{label}</p>
      {hint && <p className="max-w-[48ch] text-xs text-fg-subtle">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
