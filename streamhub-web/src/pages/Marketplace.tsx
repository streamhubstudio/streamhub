/**
 * Plugins (global /plugins) — app picker + read-only catalog.
 *
 * Plugins are installed/configured PER APP, so there is no global install state
 * to manage here. This page therefore:
 *   1. lets the user pick an app → jumps to that app's Plugins tab
 *      (`/apps/:app?tab=plugins`), which is the real management surface, and
 *   2. shows a READ-ONLY catalog of the plugins available in this build
 *      (from the auto-discovered frontend registry — no backend call, so the old
 *      "couldn't reach the plugins service" error can never appear here).
 *
 * Re-skinned with the Elstar design system (Card + Tag). The plugin glyph
 * (PluginIcon) is reused from the plugin feature's UI kit.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { getRegisteredPlugins } from '@/plugins'
import { PluginIcon } from '@/plugins/ui'
import { Card, Tag } from '@/ui'

type Tone = 'cyan' | 'slate' | 'amber'

const TAG_CLASS: Record<Tone, string> = {
  cyan: 'border-transparent bg-primary-500/10 text-primary-500',
  slate: 'border-transparent bg-gray-100 text-gray-600 dark:bg-gray-600/60 dark:text-gray-100',
  amber: 'border-transparent bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-100',
}

const PLACEMENT_TONE: Record<string, Tone> = {
  'app-tab': 'cyan',
  panel: 'slate',
  'player-overlay': 'amber',
}

export default function Marketplace() {
  const { t } = useTranslation(['marketplace', 'common'])

  const { data: apps, isLoading: appsLoading } = useQuery({
    queryKey: ['apps'],
    queryFn: ({ signal }) => api.apps.list(signal),
  })

  // Read-only: the frontend registry only (no per-app backend state here).
  const catalog = useMemo(() => getRegisteredPlugins(), [])

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-fg">{t('page.title')}</h1>
        <p className="text-sm text-slate-400">{t('picker.subtitle')}</p>
      </div>

      {/* App picker — plugins are managed inside an app. */}
      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold text-fg">
          {t('picker.selectApp')}
        </h2>
        {appsLoading ? (
          <Card bordered bodyClass="px-5 py-10 text-center text-sm text-slate-500">
            {t('picker.loadingApps')}
          </Card>
        ) : !apps || apps.length === 0 ? (
          <Card bordered bodyClass="px-5 py-10 text-center text-sm text-slate-400">
            {t('picker.noApps')}
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {apps.map((a) => (
              <Link
                key={a.name}
                to={`/apps/${encodeURIComponent(a.name)}?tab=plugins`}
                className="block"
              >
                <Card
                  bordered
                  clickable
                  bodyClass="flex items-center justify-between px-4 py-3"
                  className="transition hover:ring-1 hover:ring-primary-500/40"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-fg">
                      {a.displayName || a.name}
                    </div>
                    <div className="truncate font-mono text-[11px] text-slate-500">
                      {a.name}
                    </div>
                  </div>
                  <span className="ml-3 shrink-0 text-xs text-primary-500">
                    {t('picker.manage')} →
                  </span>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Read-only catalog of what's available in this build. */}
      <section>
        <h2 className="mb-1 text-sm font-semibold text-fg">
          {t('catalog.title')}
        </h2>
        <p className="mb-3 text-xs text-slate-500">{t('catalog.subtitle')}</p>
        {catalog.length === 0 ? (
          <Card bordered bodyClass="px-5 py-10 text-center text-sm text-slate-400">
            {t('page.empty')}
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.map((p) => (
              <Card key={p.id} bordered bodyClass="flex flex-col p-5">
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary-500/10 text-primary-500">
                    <PluginIcon icon={p.icon} className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-base font-semibold text-fg">
                      {p.name}
                    </h3>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Tag className={TAG_CLASS.slate}>{p.category}</Tag>
                      {p.ui && (
                        <Tag className={TAG_CLASS[PLACEMENT_TONE[p.ui] ?? 'slate']}>
                          {t(`placement.${p.ui}`)}
                        </Tag>
                      )}
                      {p.version && (
                        <span className="font-mono text-[11px] text-slate-500">
                          v{p.version}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <p className="mt-3 min-h-[2.5rem] text-sm text-slate-400">
                  {p.description || t('card.noDescription')}
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
