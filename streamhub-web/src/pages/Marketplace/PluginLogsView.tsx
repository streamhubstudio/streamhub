/**
 * Plugin log lines — the shared body of the logs surface (newest first).
 *
 * Reads GET /plugins/:id/logs. Non-blocking: a missing backend just shows the
 * empty/error state. Extracted so both the modal (`LogsDialog`) and the
 * full-page Studio App view render logs identically.
 */
import { useTranslation } from 'react-i18next'
import { usePluginLogs } from '@/plugins'
import { errMessage } from '@/plugins/ui'
import type { PluginView } from '@/plugins'

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

export function PluginLogsView({ app, view }: { app: string; view: PluginView }) {
  const { t } = useTranslation('marketplace')
  const { data, isLoading, isError, error } = usePluginLogs(app, view.id)
  const lines = data ?? []

  if (isLoading) return <p className="text-sm text-slate-400">{t('logs.loading')}</p>
  if (isError)
    return <p className="text-sm text-warn">{errMessage(error, t('logs.error'))}</p>
  if (lines.length === 0)
    return <p className="text-sm text-slate-400">{t('logs.empty')}</p>

  return (
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
  )
}
