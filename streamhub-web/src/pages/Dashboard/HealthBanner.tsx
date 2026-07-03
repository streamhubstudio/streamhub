/**
 * Health banner — GET /health (PLAIN, public). Polls every 12s.
 * Green when up, red on error/down. Shows version + uptime.
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, ApiRequestError, type Health } from '@/api'
import { Card } from '@/ui'
import { formatUptime } from './format'

const POLL_MS = 12_000

function Dot({ tone }: { tone: 'ok' | 'down' | 'idle' }) {
  const color =
    tone === 'ok'
      ? 'bg-emerald-400 shadow-[0_0_10px_2px_rgba(52,211,153,0.6)]'
      : tone === 'down'
        ? 'bg-red-400 shadow-[0_0_10px_2px_rgba(248,113,113,0.55)]'
        : 'bg-slate-500'
  return (
    <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />
  )
}

export function HealthBanner() {
  const { t } = useTranslation('dashboard')
  const { data, isLoading, isError, error } = useQuery<Health>({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.system.health(signal),
    refetchInterval: POLL_MS,
  })

  if (isLoading) {
    return (
      <Card bordered bodyClass="flex items-center gap-3 px-5 py-4 text-sm text-slate-400">
        <Dot tone="idle" />
        {t('health.checking')}
      </Card>
    )
  }

  const up = Boolean(data?.up) && !isError
  const message =
    error instanceof ApiRequestError
      ? error.message
      : t('health.unreachableError')

  return (
    <Card
      bordered
      bodyClass="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4"
      className={up ? 'ring-1 ring-emerald-500/20' : 'ring-1 ring-red-500/30'}
    >
      <div className="flex items-center gap-3">
        <Dot tone={up ? 'ok' : 'down'} />
        <span
          className={`text-sm font-semibold ${up ? 'text-emerald-300' : 'text-red-300'}`}
        >
          {up ? t('health.up') : t('health.down')}
        </span>
      </div>

      {up ? (
        <>
          <Field label={t('health.status')} value={data?.status ?? '—'} />
          <Field label={t('health.version')} value={data?.version ?? '—'} />
          <Field label={t('health.uptime')} value={formatUptime(data?.uptimeSeconds)} />
        </>
      ) : (
        <span className="text-sm text-red-300/80">{message}</span>
      )}
    </Card>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <span className="text-sm text-slate-200">{value}</span>
    </div>
  )
}
