/**
 * Shared bits for the RTMP→HLS passthrough (remux, no transcode) UI, used by
 * both the Ingress tab (create form + create result) and the Config tab
 * (rtmp.passthrough toggle). Passthrough gives up everything that needs the
 * media to enter LiveKit — these surfaces warn the operator before they commit.
 */
import type { ReactNode } from 'react'

/**
 * "What you lose vs the LiveKit path" warning: a titled bullet list. The caller
 * supplies the lines — a static localized list before submit, or the exact
 * `capabilities.lost` array the API returns after a passthrough create.
 */
export function PassthroughLostWarning({
  title,
  items,
  children,
}: {
  title: string
  items: string[]
  children?: ReactNode
}) {
  return (
    <div
      role="note"
      className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
    >
      <div className="text-sm font-semibold text-amber-700 dark:text-amber-200">
        {title}
      </div>
      <ul className="list-disc space-y-1 pl-5 text-[11px] text-amber-700 dark:text-amber-200/90">
        {items.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      {children}
    </div>
  )
}
