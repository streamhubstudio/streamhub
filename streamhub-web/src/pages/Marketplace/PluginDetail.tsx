/**
 * Plugin (Studio app) DETAIL view — the in-app equivalent of the public site's
 * per-plugin landing page.
 *
 * Opened from a Studio card (per-app PluginsTab or the global Marketplace
 * catalog) it shows, in one place:
 *   - the name + a VERSION badge (from the backend manifest) + category /
 *     placement / status badges + an "experimental" flag;
 *   - a mini landing: the manifest description plus a longer "what it does" and
 *     concrete "use cases" (bilingual, from `@/plugins/blurbs`);
 *   - a "Learn more" docs deep-link (same DocsHint pattern as everywhere else);
 *   - and, WHEN opened inside an app (`app` set) for an installed plugin, the
 *     enable/disable toggle, the configSchema-driven config form (reused
 *     verbatim) and a "View logs" affordance for worker plugins.
 *
 * A self-contained modal (own overlay + Esc/backdrop close + scroll lock),
 * mirroring the page's Modal, so callers just conditionally render it.
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfigForm } from '@/plugins'
import { Badge, Button, PluginIcon, Toggle } from '@/plugins/ui'
import { DocsHint } from '@/components/DocsHint'
import { getBlurb } from '@/plugins/blurbs'
import type { PluginView } from '@/plugins'

const PLACEMENT_TONE = {
  'app-tab': 'cyan',
  panel: 'slate',
  'player-overlay': 'amber',
  player: 'green',
} as const

export function PluginDetail({
  view,
  app,
  canEdit = false,
  busy = false,
  onToggleActive,
  onShowLogs,
  onClose,
}: {
  view: PluginView
  /** App slug — when set, unlocks the enable/disable + config + logs controls. */
  app?: string
  canEdit?: boolean
  busy?: boolean
  onToggleActive?: (active: boolean) => void
  onShowLogs?: () => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation(['marketplace', 'common'])
  const blurb = getBlurb(view.id, i18n.language)

  const status = view.active ? 'active' : view.installed ? 'installed' : 'available'
  const statusTone = view.active ? 'green' : view.installed ? 'cyan' : 'slate'
  const hasConfig =
    Boolean(view.configSchema?.fields.length) ||
    Boolean(view.registered?.ConfigComponent)
  const inApp = Boolean(app)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/70 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={view.name}
    >
      <div
        className="glass flex max-h-[92vh] w-full max-w-2xl flex-col rounded-t-2xl shadow-2xl sm:max-h-[90vh] sm:rounded-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start gap-3 border-b border-navy-600 px-5 py-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-blue2/15 text-sky2">
            <PluginIcon icon={view.icon} className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold text-fg">{view.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {view.kind === 'app' && <Badge tone="cyan">{t('kind.app')}</Badge>}
              <Badge tone="slate">{view.category}</Badge>
              {view.ui && (
                <Badge tone={PLACEMENT_TONE[view.ui]}>
                  {t(`placement.${view.ui}`)}
                </Badge>
              )}
              {view.edge && <Badge tone="violet">{t('badge.edge')}</Badge>}
              {view.version && (
                <Badge tone="cyan">v{view.version}</Badge>
              )}
              {inApp && <Badge tone={statusTone}>{t(`status.${status}`)}</Badge>}
              {blurb?.experimental && (
                <Badge tone="amber">{t('detail.experimental')}</Badge>
              )}
            </div>
          </div>
          <div className="ml-1 flex shrink-0 items-center gap-2">
            <DocsHint section="plugins" showLabel />
            <button
              onClick={onClose}
              aria-label={t('common:actions.close')}
              className="rounded-md p-1 text-slate-400 transition hover:text-fg"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 6l12 12M18 6L6 18"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="space-y-6 overflow-y-auto px-5 py-5">
          {/* Mini landing */}
          <section className="space-y-3">
            <p className="text-sm text-slate-300">
              {view.description || t('card.noDescription')}
            </p>
            {blurb?.what && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {t('detail.whatItDoes')}
                </h3>
                <p className="text-sm text-slate-300">{blurb.what}</p>
              </div>
            )}
            {blurb?.useCases && blurb.useCases.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {t('detail.useCases')}
                </h3>
                <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
                  {blurb.useCases.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* Management (per-app only) */}
          {inApp && app && view.installed ? (
            <>
              {onToggleActive && (
                <section className="flex items-center justify-between gap-4 rounded-lg bg-white/5 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-fg">
                      {t('detail.status')}
                    </div>
                    <div className="text-xs text-slate-400">
                      {view.active ? t('actions.active') : t('actions.inactive')}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {onShowLogs && (
                      <Button variant="ghost" onClick={onShowLogs}>
                        {t('detail.viewLogs')}
                      </Button>
                    )}
                    <Toggle
                      checked={view.active}
                      onChange={(v) => onToggleActive(v)}
                      disabled={!canEdit || busy}
                    />
                  </div>
                </section>
              )}

              {hasConfig && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold text-fg">
                    {t('detail.settings')}
                  </h3>
                  <ConfigForm app={app} view={view} onDone={onClose} />
                </section>
              )}
            </>
          ) : (
            <p className="rounded-lg bg-white/5 px-4 py-3 text-xs text-slate-400">
              {t('detail.manageInApp')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
