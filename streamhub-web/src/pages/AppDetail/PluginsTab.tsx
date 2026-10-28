/**
 * Plugins tab — per-app marketplace inside AppDetail.
 *
 * Plugins are installed/configured PER APP, so this is the real management
 * surface: the catalog (auto-discovered frontend registry merged with this app's
 * backend install state via `usePluginCatalog(app)`) plus the lifecycle actions
 * (install / enable / OPEN / configure / logs / uninstall), all scoped to `:app`.
 *
 * Because the read model is app-scoped, the "couldn't reach the plugins service"
 * banner only appears on a genuine backend failure for THIS app — not the old
 * global page which had no app to query.
 *
 * Installed `app-tab`/`panel` plugins are OPENED from here (the "Open" button
 * mounts the plugin's surface in a full-width dialog) instead of adding extra
 * tabs to AppDetail. `player-overlay` plugins keep rendering over the live
 * players (/play, /embed) — that host is untouched.
 */
import { Component, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/useAuth'
import { Dialog as UIDialog } from '@/ui'
import {
  ConfigForm,
  useInstallPlugin,
  usePluginCatalog,
  useSetPluginActive,
  useUninstallPlugin,
} from '@/plugins'
import { errMessage, PluginIcon } from '@/plugins/ui'
import type { PluginView } from '@/plugins'
import {
  catalogCategories,
  openTargetFor,
  partitionByKind,
  studioAppPath,
} from '@/plugins/state'
import { PluginCard } from '../Marketplace/PluginCard'
import { PluginDetail } from '../Marketplace/PluginDetail'
import { Modal } from '../Marketplace/Modal'
import { LogsDialog } from '../Marketplace/LogsDialog'
import { Button, Card, ErrorBanner } from './ui'

type Dialog =
  | { kind: 'config'; view: PluginView }
  | { kind: 'logs'; view: PluginView }
  | { kind: 'open'; view: PluginView }
  | { kind: 'detail'; view: PluginView }
  | null

const ALL = '__all__'

/**
 * Per-plugin error boundary so a misbehaving plugin can't take down the
 * Plugins tab (same contract the old AppDetail plugin-tab host had).
 */
class PluginBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    return this.state.error ? this.props.fallback : this.props.children
  }
}

/** True when the plugin has an openable surface (app-tab/panel with a component). */
function isOpenable(view: PluginView): boolean {
  if (!view.installed || !view.active || !view.hasFrontend) return false
  if (view.ui === 'panel') return Boolean(view.registered?.PanelComponent)
  if (view.ui === 'app-tab') return Boolean(view.registered?.TabComponent)
  return false
}

/**
 * Mount ONE plugin surface (only while its dialog is open — plugins that grab
 * camera/mic on mount never fight over devices). Picks the component by the
 * plugin's placement: `app-tab` → TabComponent, `panel` → PanelComponent.
 */
function PluginSurface({ view, app }: { view: PluginView; app: string }) {
  const { t } = useTranslation('marketplace')
  const Comp =
    view.ui === 'panel'
      ? view.registered?.PanelComponent
      : view.registered?.TabComponent
  if (!Comp) return null
  return (
    <PluginBoundary
      fallback={
        <div className="rounded-lg px-4 py-3 text-xs font-medium bg-red-500/15 text-red-100">
          {t('host.crashed', { id: view.id })}
        </div>
      }
    >
      <Comp ctx={{ app, config: view.config }} pluginId={view.id} />
    </PluginBoundary>
  )
}

export function PluginsTab({ app }: { app: string }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const { canEdit } = useAuth()
  const navigate = useNavigate()
  const { views, isLoading, isFetching, backendError, refetch } =
    usePluginCatalog(app)

  const install = useInstallPlugin(app)
  const uninstall = useUninstallPlugin(app)
  const setActive = useSetPluginActive(app)

  const [category, setCategory] = useState<string>(ALL)
  const [dialog, setDialog] = useState<Dialog>(null)

  const categories = useMemo(() => catalogCategories(views), [views])
  const filtered = useMemo(
    () =>
      category === ALL ? views : views.filter((v) => v.category === category),
    [views, category],
  )

  // Shelves: Apps first, then Plugins (the category filter still applies).
  const shelves = useMemo(() => partitionByKind(filtered), [filtered])

  // Installed Studio Apps get a quick-launch strip at the top — one click from
  // the app to the running App page (regardless of category filter).
  const installedApps = useMemo(
    () => views.filter((v) => v.kind === 'app' && v.installed && v.hasFrontend),
    [views],
  )

  /** Open a view: apps navigate to their full page, plugins open the modal. */
  function handleOpen(view: PluginView) {
    if (openTargetFor(view) === 'page') navigate(studioAppPath(app, view.id))
    else setDialog({ kind: 'open', view })
  }

  // A plugin is "busy" while any of its mutations are in flight.
  const pendingId =
    (install.isPending && install.variables) ||
    (uninstall.isPending && uninstall.variables) ||
    (setActive.isPending && setActive.variables?.id) ||
    null

  const actionError = install.error || uninstall.error || setActive.error || null

  function onUninstall(view: PluginView) {
    if (!window.confirm(t('confirm.uninstall', { name: view.name }))) return
    uninstall.mutate(view.id)
  }

  /** One catalog card — shared by the Apps and Plugins shelves. */
  function renderCard(view: PluginView) {
    return (
      <PluginCard
        key={view.id}
        view={view}
        canEdit={canEdit}
        busy={pendingId === view.id}
        onInstall={() => install.mutate(view.id)}
        onUninstall={() => onUninstall(view)}
        onToggleActive={(active) => setActive.mutate({ id: view.id, active })}
        onOpen={isOpenable(view) ? () => handleOpen(view) : undefined}
        onConfigure={() => setDialog({ kind: 'config', view })}
        onLogs={() => setDialog({ kind: 'logs', view })}
        onDetails={() => setDialog({ kind: 'detail', view })}
      />
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-fg-muted">{t('page.subtitle')}</p>
        <Button variant="ghost" onClick={() => refetch()}>
          {isFetching ? t('page.refreshing') : t('common:actions.refresh')}
        </Button>
      </div>

      {/* Non-blocking backend banner (real failure for THIS app only). */}
      {Boolean(backendError) && (
        <div className="mb-5">
          <ErrorBanner message={t('page.backendOffline')} />
        </div>
      )}
      {actionError && (
        <div className="mb-5 rounded-lg px-4 py-3 text-sm font-medium bg-red-500/15 text-red-100">
          {errMessage(actionError, t('page.actionError'))}
        </div>
      )}

      {/* Quick-launch: installed Studio Apps, one click to their full page. */}
      {!isLoading && installedApps.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-fg">
            {t('shelf.yourApps')}
          </h2>
          <div className="flex flex-wrap gap-2">
            {installedApps.map((view) => (
              <button
                key={view.id}
                type="button"
                onClick={() => navigate(studioAppPath(app, view.id))}
                className="glass flex items-center gap-2 rounded-lg px-3 py-2 text-left transition hover:ring-1 hover:ring-blue2/40"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-blue2/15 text-sky2">
                  <PluginIcon icon={view.icon} className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-fg">
                    {view.name}
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    {view.active ? t('actions.active') : t('actions.inactive')}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Category filter — Elstar pill tabs. */}
      {categories.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {[ALL, ...categories].map((c) => {
            const isActive = c === category
            return (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={[
                  'rounded-md px-3 py-1.5 text-sm font-semibold transition',
                  isActive
                    ? 'bg-primary-500 text-gray-100'
                    : 'text-gray-400 hover:text-primary-100',
                ].join(' ')}
              >
                {c === ALL ? t('page.allCategories') : c}
              </button>
            )
          })}
        </div>
      )}

      {/* Catalog — Apps shelf first, then Plugins. */}
      {isLoading ? (
        <Card className="text-center">
          <div className="px-5 py-11 text-sm text-fg-subtle">
            {t('page.loading')}
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="text-center">
          <div className="px-5 py-11">
            <p className="text-sm text-fg-muted">{t('page.empty')}</p>
            <p className="mt-1 text-xs text-fg-subtle">{t('page.emptyHint')}</p>
          </div>
        </Card>
      ) : (
        <div className="space-y-8">
          {shelves.apps.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-fg">
                {t('shelf.apps')}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {shelves.apps.map(renderCard)}
              </div>
            </section>
          )}
          {shelves.plugins.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-fg">
                {t('shelf.plugins')}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {shelves.plugins.map(renderCard)}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Detail / mini-landing + config view */}
      {dialog?.kind === 'detail' && (
        <PluginDetail
          view={dialog.view}
          app={app}
          canEdit={canEdit}
          busy={pendingId === dialog.view.id}
          onToggleActive={(active) =>
            setActive.mutate({ id: dialog.view.id, active })
          }
          onShowLogs={() => setDialog({ kind: 'logs', view: dialog.view })}
          onClose={() => setDialog(null)}
        />
      )}

      {/* Configure dialog */}
      {dialog?.kind === 'config' && (
        <Modal
          title={t('config.title', { name: dialog.view.name })}
          subtitle={dialog.view.description || undefined}
          onClose={() => setDialog(null)}
        >
          <ConfigForm
            app={app}
            view={dialog.view}
            onDone={() => setDialog(null)}
          />
        </Modal>
      )}

      {/* Logs dialog */}
      {dialog?.kind === 'logs' && (
        <LogsDialog app={app} view={dialog.view} onClose={() => setDialog(null)} />
      )}

      {/* Open-plugin dialog: mounts the plugin's own UI (app-tab/panel). */}
      {dialog?.kind === 'open' && (
        <UIDialog
          isOpen
          width={980}
          closable={false}
          onClose={() => setDialog(null)}
          onRequestClose={() => setDialog(null)}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h5 className="truncate text-base font-semibold text-gray-100">
                {dialog.view.name}
              </h5>
              {dialog.view.description && (
                <p className="mt-0.5 truncate text-xs text-gray-400">
                  {dialog.view.description}
                </p>
              )}
            </div>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('common:actions.close')}
            </Button>
          </div>
          <div className="max-h-[75vh] overflow-y-auto pr-1">
            <PluginSurface view={dialog.view} app={app} />
          </div>
        </UIDialog>
      )}
    </div>
  )
}
