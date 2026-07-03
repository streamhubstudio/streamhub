/**
 * A single Marketplace card: icon + name + description + category/version, a
 * status badge, and the lifecycle actions (Install / Activate / Configure /
 * Logs / Uninstall). Mutations + gating are owned by the parent page; this is
 * mostly presentational.
 */
import { useTranslation } from 'react-i18next'
import {
  HiOutlineCog,
  HiOutlineDocumentText,
  HiOutlineDownload,
  HiOutlineExternalLink,
  HiOutlineTrash,
} from 'react-icons/hi'
import { Tooltip } from '@/ui'
import { Badge, Button, PluginIcon, Toggle } from '@/plugins/ui'
import type { PluginView } from '@/plugins'

const PLACEMENT_TONE = {
  'app-tab': 'cyan',
  panel: 'slate',
  'player-overlay': 'amber',
} as const

export function PluginCard({
  view,
  canEdit,
  busy,
  onInstall,
  onUninstall,
  onToggleActive,
  onOpen,
  onConfigure,
  onLogs,
}: {
  view: PluginView
  canEdit: boolean
  busy: boolean
  onInstall: () => void
  onUninstall: () => void
  onToggleActive: (active: boolean) => void
  /** Opens the plugin's own UI (installed+active app-tab/panel plugins). */
  onOpen?: () => void
  onConfigure: () => void
  onLogs: () => void
}) {
  const { t } = useTranslation('marketplace')

  const status = view.active ? 'active' : view.installed ? 'installed' : 'available'
  const statusTone = view.active ? 'green' : view.installed ? 'cyan' : 'slate'
  const hasConfig =
    Boolean(view.configSchema?.fields.length) || Boolean(view.registered?.ConfigComponent)

  return (
    <div className="glass flex flex-col rounded-xl p-5 transition hover:ring-1 hover:ring-blue2/40">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue2/15 text-sky2">
          <PluginIcon icon={view.icon} className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold text-fg">{view.name}</h3>
            <Badge tone={statusTone}>{t(`status.${status}`)}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="slate">{view.category}</Badge>
            {view.ui && (
              <Badge tone={PLACEMENT_TONE[view.ui]}>{t(`placement.${view.ui}`)}</Badge>
            )}
            {view.version && (
              <span className="font-mono text-[11px] text-slate-500">v{view.version}</span>
            )}
          </div>
        </div>
      </div>

      <p className="mt-3 min-h-[2.5rem] text-sm text-slate-400">
        {view.description || t('card.noDescription')}
      </p>

      {!view.hasFrontend && (
        <p className="mt-1 text-[11px] text-warn">{t('card.backendOnly')}</p>
      )}

      {/* Action bar: icon-only controls, each with a hover tooltip naming it. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!view.installed ? (
          <Tooltip title={busy ? t('actions.working') : t('actions.install')}>
            <Button
              variant="accent"
              disabled={!canEdit || busy}
              onClick={onInstall}
              aria-label={t('actions.install')}
            >
              <HiOutlineDownload className="h-4 w-4" />
            </Button>
          </Tooltip>
        ) : (
          <>
            <Tooltip title={view.active ? t('actions.active') : t('actions.inactive')}>
              <span className="mr-1 inline-flex items-center">
                <Toggle
                  checked={view.active}
                  onChange={onToggleActive}
                  disabled={!canEdit || busy}
                />
              </span>
            </Tooltip>
            {onOpen && (
              <Tooltip title={t('actions.open')}>
                <Button
                  variant="accent"
                  disabled={busy}
                  onClick={onOpen}
                  aria-label={t('actions.open')}
                >
                  <HiOutlineExternalLink className="h-4 w-4" />
                </Button>
              </Tooltip>
            )}
            {hasConfig && (
              <Tooltip title={t('actions.configure')}>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={onConfigure}
                  aria-label={t('actions.configure')}
                >
                  <HiOutlineCog className="h-4 w-4" />
                </Button>
              </Tooltip>
            )}
            <Tooltip title={t('actions.logs')}>
              <Button variant="ghost" onClick={onLogs} aria-label={t('actions.logs')}>
                <HiOutlineDocumentText className="h-4 w-4" />
              </Button>
            </Tooltip>
            <Tooltip title={t('actions.uninstall')} wrapperClass="ml-auto">
              <Button
                variant="danger"
                disabled={!canEdit || busy}
                onClick={onUninstall}
                aria-label={t('actions.uninstall')}
              >
                <HiOutlineTrash className="h-4 w-4" />
              </Button>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  )
}
