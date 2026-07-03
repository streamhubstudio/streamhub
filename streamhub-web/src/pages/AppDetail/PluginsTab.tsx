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
import { errMessage } from '@/plugins/ui'
import type { PluginView } from '@/plugins'
import { catalogCategories } from '@/plugins/state'
import { PluginCard } from '../Marketplace/PluginCard'
import { Modal } from '../Marketplace/Modal'
import { LogsDialog } from '../Marketplace/LogsDialog'
import { Button, Card, ErrorBanner } from './ui'

type Dialog =
  | { kind: 'config'; view: PluginView }
  | { kind: 'logs'; view: PluginView }
  | { kind: 'open'; view: PluginView }
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
        <div className="rounded-lg bg-red-50 px-4 py-3 text-xs font-medium text-red-700 dark:bg-red-500/15 dark:text-red-100">
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
        <div className="mb-5 rounded-lg bg-red-50 px-4 py-3 text-sm font-medium text-red-700 dark:bg-red-500/15 dark:text-red-100">
          {errMessage(actionError, t('page.actionError'))}
        </div>
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
                    ? 'bg-primary-50 text-primary-600 dark:bg-primary-500 dark:text-gray-100'
                    : 'text-gray-500 hover:text-primary-600 dark:text-gray-400 dark:hover:text-primary-100',
                ].join(' ')}
              >
                {c === ALL ? t('page.allCategories') : c}
              </button>
            )
          })}
        </div>
      )}

      {/* Catalog */}
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((view) => (
            <PluginCard
              key={view.id}
              view={view}
              canEdit={canEdit}
              busy={pendingId === view.id}
              onInstall={() => install.mutate(view.id)}
              onUninstall={() => onUninstall(view)}
              onToggleActive={(active) =>
                setActive.mutate({ id: view.id, active })
              }
              onOpen={
                isOpenable(view)
                  ? () => setDialog({ kind: 'open', view })
                  : undefined
              }
              onConfigure={() => setDialog({ kind: 'config', view })}
              onLogs={() => setDialog({ kind: 'logs', view })}
            />
          ))}
        </div>
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
              <h5 className="truncate text-base font-semibold text-gray-900 dark:text-gray-100">
                {dialog.view.name}
              </h5>
              {dialog.view.description && (
                <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
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
