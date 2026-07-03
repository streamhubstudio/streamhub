/**
 * Plugin logs dialog — reads GET /plugins/:id/logs (newest first). Non-blocking:
 * a missing backend just shows the empty/error state.
 */
import { useTranslation } from 'react-i18next'
import { usePluginLogs } from '@/plugins'
import { errMessage } from '@/plugins/ui'
import type { PluginView } from '@/plugins'
import { Modal } from './Modal'

function levelTone(level?: string): string {
  switch ((level ?? '').toLowerCase()) {
    case 'error':
      return 'text-danger'
    case 'warn':
    case 'warning':
      return 'text-warn'
    case 'debug':
      return 'text-slate-500'
    default:
      return 'text-slate-300'
  }
}

export function LogsDialog({
  app,
  view,
  onClose,
}: {
  app: string
  view: PluginView
  onClose: () => void
}) {
  const { t } = useTranslation('marketplace')
  const { data, isLoading, isError, error } = usePluginLogs(app, view.id)
  const lines = data ?? []

  return (
    <Modal title={t('logs.title', { name: view.name })} onClose={onClose} wide>
      {isLoading ? (
        <p className="text-sm text-slate-400">{t('logs.loading')}</p>
      ) : isError ? (
        <p className="text-sm text-warn">{errMessage(error, t('logs.error'))}</p>
      ) : lines.length === 0 ? (
        <p className="text-sm text-slate-400">{t('logs.empty')}</p>
      ) : (
        <ul className="space-y-1 font-mono text-[11px] leading-relaxed">
          {lines.map((l, i) => (
            <li key={i} className="flex gap-2">
              {l.ts && <span className="shrink-0 text-slate-500">{l.ts}</span>}
              {l.level && (
                <span className={`shrink-0 uppercase ${levelTone(l.level)}`}>{l.level}</span>
              )}
              <span className="min-w-0 break-words text-slate-300">
                {l.message ?? JSON.stringify(l)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
