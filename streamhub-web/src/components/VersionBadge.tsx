/**
 * VersionBadge — the running StreamHub version, always on screen, and the
 * trigger of the About / Build panel (build details + changelog).
 *
 * The version comes from the public bootstrap endpoint GET /auth/config
 * (`appVersion` — the repo-root VERSION the core reports), NOT from any
 * package.json. Shares the ['auth-config'] query key with the login screen so
 * it's fetched once per session. Renders nothing while loading or against an
 * older backend that doesn't send the field — no bogus version on screen.
 *
 * Variants:
 *  - `slate` (sidebar footer): tally LED + product + version; in the
 *    collapsed rail just the version.
 *  - `chip` (top bar, < lg where the sidebar is hidden): compact version.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import { AboutPanel } from '@/components/about/AboutPanel'

export function VersionBadge({
  variant = 'chip',
  collapsed = false,
  className = '',
}: {
  variant?: 'slate' | 'chip'
  collapsed?: boolean
  className?: string
}) {
  const { t } = useTranslation('about')
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['auth-config'],
    queryFn: ({ signal }) => api.auth.config(signal),
    staleTime: 5 * 60_000,
  })

  const version = data?.appVersion?.trim().replace(/^v/, '')
  if (!version) return null
  const label = t('open', { version: `v${version}` })

  const button =
    variant === 'slate' ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        aria-haspopup="dialog"
        title={label}
        data-testid="version-badge"
        className={[
          'group flex w-full items-center rounded-control border border-border bg-surface/60 text-left transition hover:border-border-strong hover:bg-surface-raised',
          collapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-3 py-2',
          className,
        ].join(' ')}
      >
        <span className="tally shrink-0 text-success" aria-hidden="true" />
        {collapsed ? (
          <span className="font-mono text-[11px] font-semibold text-fg tabular-nums">{version}</span>
        ) : (
          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
            <span className="truncate text-xs text-fg-muted group-hover:text-fg">StreamHub</span>
            <span className="font-mono text-sm font-semibold text-fg tabular-nums">v{version}</span>
          </span>
        )}
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        aria-haspopup="dialog"
        title={label}
        data-testid="version-badge"
        className={[
          'inline-flex items-center gap-1.5 rounded-chip border border-border px-2 py-1 font-mono text-xs font-semibold text-fg tabular-nums transition hover:border-border-strong hover:bg-surface-raised',
          className,
        ].join(' ')}
      >
        <span className="tally text-success" aria-hidden="true" />v{version}
      </button>
    )

  return (
    <>
      {button}
      {open && <AboutPanel isOpen={open} onClose={() => setOpen(false)} appVersion={version} />}
    </>
  )
}
