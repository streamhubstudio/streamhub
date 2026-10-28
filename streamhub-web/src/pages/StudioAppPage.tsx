/**
 * Full-page Studio App view — `apps/:app/studio/:pluginId`.
 *
 * A Studio App (`kind: 'app'`) is a full application, not a modal: it opens as
 * its own page inside the management shell. Composition:
 *   - header: icon + name + version/kind/worker badges + enable/disable toggle;
 *   - PRIMARY surface: the app's main component rendered FULL-BLEED via the
 *     shared `componentFor` logic (panel → PanelComponent, app-tab →
 *     TabComponent), inside a `PluginErrorBoundary`;
 *   - secondary tabs: Overview (the bilingual blurb mini-landing), Settings
 *     (the reused `ConfigForm`), Logs (the reused `PluginLogsView`) and — only
 *     when the backend reports `exportable` — Export (download the standalone
 *     bundle).
 *
 * Not-installed / no-surface are handled gracefully with an informative empty
 * state that links back to the app's Studio tab (no toast dependency).
 */
import { useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/useAuth'
import { requestBlob, saveBlob } from '@/api/http'
import {
  BoundaryFallback,
  componentFor,
  ConfigForm,
  PluginErrorBoundary,
  usePluginCatalog,
  useSetPluginActive,
} from '@/plugins'
import type { PluginView } from '@/plugins'
import { useQuery } from '@tanstack/react-query'
import { pluginsApi } from '@/plugins/api'
import { findView, resolveSection, sectionsOf, studioAppPath, workerBadge } from '@/plugins/state'
import { getBlurb } from '@/plugins/blurbs'
import { Badge, Button, PluginIcon, Toggle, errMessage } from '@/plugins/ui'
import { Card } from '@/ui'
import { DocsHint } from '@/components/DocsHint'
import { CopyLinkButton } from '@/components/CopyLinkButton'
import { PluginLogsView } from './Marketplace/PluginLogsView'

type SecondaryTab = 'overview' | 'settings' | 'logs' | 'export'

export default function StudioAppPage() {
  const { app = '', pluginId = '', section } = useParams()
  const { t, i18n } = useTranslation(['marketplace', 'common'])
  const { canEdit } = useAuth()

  const { views, isLoading } = usePluginCatalog(app)
  const view = useMemo(() => findView(views, pluginId), [views, pluginId])

  const studioTab = `/apps/${encodeURIComponent(app)}?tab=plugins`

  // Resolve the :section deep link against the app's declared sections. An
  // unknown segment redirects to the default section (no crash); an absent one
  // resolves to the default without changing the URL (back-compat).
  const sections = view ? sectionsOf(view) : []
  const resolved = resolveSection(sections, section)
  if (view && view.installed && resolved.redirect && resolved.section) {
    return <Navigate to={studioAppPath(app, pluginId, resolved.section)} replace />
  }

  if (isLoading) {
    return (
      <div>
        <BackLink to={studioTab} label={t('studio.back')} />
        <Card bordered bodyClass="px-5 py-14 text-center text-sm text-slate-400">
          {t('page.loading')}
        </Card>
      </div>
    )
  }

  // Not found, or found-but-not-installed → informative empty state. The page
  // only makes sense for an app that's actually installed in THIS tenant app.
  if (!view || !view.installed) {
    return (
      <div>
        <BackLink to={studioTab} label={t('studio.back')} />
        <Card bordered bodyClass="px-5 py-14 text-center">
          <p className="text-sm text-fg-muted">{t('studio.notInstalled')}</p>
          <p className="mt-1 text-xs text-slate-500">{t('studio.notInstalledHint')}</p>
          <Link
            to={studioTab}
            className="mt-4 inline-block text-sm font-semibold text-primary-500 hover:underline"
          >
            {t('studio.openStudio')} →
          </Link>
        </Card>
      </div>
    )
  }

  return (
    <StudioApp
      app={app}
      view={view}
      canEdit={canEdit}
      language={i18n.language}
      activeSection={resolved.section}
    />
  )
}

function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="mb-3 inline-flex items-center gap-1 text-xs text-fg-subtle transition hover:text-fg"
    >
      <span aria-hidden>←</span> {label}
    </Link>
  )
}

function StudioApp({
  app,
  view,
  canEdit,
  language,
  activeSection,
}: {
  app: string
  view: PluginView
  canEdit: boolean
  language: string
  /** Active primary-surface section (from the :section route param), or null when the app declares none. */
  activeSection: string | null
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const navigate = useNavigate()
  const setActive = useSetPluginActive(app)
  const [tab, setTab] = useState<SecondaryTab>('overview')

  // The worker badge reflects the PROCESS state, polled — not the enabled flag
  // (an enabled app whose worker crashed must not read "running").
  const workerQ = useQuery({
    queryKey: ['plugins', app, view.id, 'worker-status'],
    queryFn: ({ signal }) => pluginsApi.workerStatus(app, view.id, signal),
    enabled: Boolean(view.needsWorker && view.installed),
    refetchInterval: 5000,
  })
  const badge = workerBadge(workerQ.data?.status)

  // Bind the plugin surface's section to the URL: switching a section navigates
  // to its deep link (replace → in-page tabbing doesn't stack history), and the
  // active section flows down through ctx so the surface renders it. Only wired
  // when the app declares sections; otherwise the surface owns its own state.
  const hasSections = activeSection != null
  const canonicalPath = studioAppPath(app, view.id, activeSection ?? undefined)
  const canonicalUrl =
    (typeof window !== 'undefined' ? window.location.origin : '') + canonicalPath

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const blurb = getBlurb(view.id, language)
  const Surface = componentFor(view)
  const hasConfig =
    Boolean(view.configSchema?.fields.length) ||
    Boolean(view.registered?.ConfigComponent)

  const TABS: SecondaryTab[] = [
    'overview',
    'settings',
    'logs',
    ...(view.exportable ? (['export'] as const) : []),
  ]

  async function onExport() {
    setExporting(true)
    setExportError(null)
    try {
      const blob = await requestBlob(
        `/apps/${encodeURIComponent(app)}/plugins/${encodeURIComponent(view.id)}/export`,
      )
      const version = view.version ? `-${view.version}` : ''
      saveBlob(blob, `streamhub-app-${view.id}${version}.tar.gz`)
    } catch (e) {
      setExportError(errMessage(e, t('export.error')))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      <BackLink to={`/apps/${encodeURIComponent(app)}?tab=plugins`} label={t('studio.back')} />

      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-blue2/15 text-sky2">
          <PluginIcon icon={view.icon} className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-semibold text-fg">{view.name}</h1>
            <DocsHint section="plugins" />
            <CopyLinkButton
              url={canonicalUrl}
              label={t('studio.copyLink')}
              copiedLabel={t('studio.copyLinkDone')}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone="cyan">{t('kind.app')}</Badge>
            <Badge tone="slate">{view.category}</Badge>
            {view.version && <Badge tone="slate">v{view.version}</Badge>}
            {view.needsWorker && (
              <Badge tone={badge.tone}>
                {t(`studio.worker.${badge.key}`)}
                {badge.key === 'crashed' && workerQ.data?.exitCode != null
                  ? ` (exit ${workerQ.data.exitCode})`
                  : ''}
              </Badge>
            )}
          </div>
        </div>
        {/* Enable/disable */}
        <div className="flex shrink-0 items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
          <span className="text-xs text-slate-400">
            {view.active ? t('actions.active') : t('actions.inactive')}
          </span>
          <Toggle
            checked={view.active}
            onChange={(active) => setActive.mutate({ id: view.id, active })}
            disabled={!canEdit || setActive.isPending}
          />
        </div>
      </div>

      {setActive.error && (
        <div className="mb-4 rounded-lg px-4 py-3 text-sm font-medium bg-red-500/15 text-red-100">
          {errMessage(setActive.error, t('page.actionError'))}
        </div>
      )}

      {/* PRIMARY surface — full-bleed. */}
      <Card bordered bodyClass="p-0" className="mb-6 overflow-hidden">
        {Surface ? (
          <div className="p-4 sm:p-5">
            <PluginErrorBoundary
              pluginId={view.id}
              fallback={(id) => <BoundaryFallback pluginId={id} />}
            >
              <Surface
                ctx={{
                  app,
                  config: view.config,
                  ...(hasSections
                    ? {
                        section: activeSection ?? undefined,
                        onSectionChange: (id: string) =>
                          navigate(studioAppPath(app, view.id, id), { replace: true }),
                      }
                    : {}),
                }}
                pluginId={view.id}
              />
            </PluginErrorBoundary>
          </div>
        ) : (
          <div className="px-5 py-14 text-center text-sm text-slate-400">
            {t('studio.noSurface')}
          </div>
        )}
      </Card>

      {/* Secondary tabs */}
      <div className="mb-4 flex flex-wrap gap-2 border-b border-navy-600">
        {TABS.map((id) => {
          const isActive = id === tab
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={[
                '-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition',
                isActive
                  ? 'border-primary-500 text-primary-500'
                  : 'border-transparent text-slate-500 hover:text-primary-500',
              ].join(' ')}
            >
              {t(`studio.tabs.${id}`)}
            </button>
          )
        })}
      </div>

      {tab === 'overview' && (
        <section className="space-y-4">
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
      )}

      {tab === 'settings' && (
        <section>
          {hasConfig ? (
            <ConfigForm app={app} view={view} />
          ) : (
            <p className="text-sm text-slate-400">{t('config.noSettings')}</p>
          )}
        </section>
      )}

      {tab === 'logs' && (
        <section>
          <PluginLogsView app={app} view={view} />
        </section>
      )}

      {tab === 'export' && view.exportable && (
        <section className="max-w-xl space-y-4">
          <div>
            <h3 className="mb-1 text-sm font-semibold text-fg">{t('export.title')}</h3>
            <p className="text-sm text-slate-400">{t('export.description')}</p>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-400">
            <li>{t('export.contents.worker')}</li>
            <li>{t('export.contents.docker')}</li>
            <li>{t('export.contents.env')}</li>
            <li>{t('export.contents.readme')}</li>
            <li>{t('export.contents.license')}</li>
          </ul>
          {exportError && (
            <div className="rounded-lg px-4 py-3 text-sm font-medium bg-red-500/15 text-red-100">
              {exportError}
            </div>
          )}
          <Button variant="accent" onClick={onExport} disabled={exporting}>
            {exporting ? t('export.downloading') : t('export.download')}
          </Button>
        </section>
      )}
    </div>
  )
}
