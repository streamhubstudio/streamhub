/**
 * Metric cards driven by GET /stats (PLAIN body, auth required). Polls 12s.
 *
 * Derived metrics (per verified API notes):
 *   CPU%  = loadAvg[0] / cores * 100
 *   Mem%  = memory.usedBytes / memory.totalBytes * 100
 *   Disk% = disk.usedBytes  / disk.totalBytes  * 100   (disk may be null)
 *   Streams = counts.activeStreams · Apps = counts.apps · Rooms = counts.rooms
 *   Ingress active = ingress.active / ingress.total
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, ApiRequestError, type Stats } from '@/api'
import { Alert } from '@/ui'
import { StatCard } from './StatCard'
import { formatBytes } from './format'

const POLL_MS = 12_000

function pct(used: number | undefined, total: number | undefined): number | null {
  if (used == null || total == null || total <= 0) return null
  return (used / total) * 100
}

function cpuPct(s: Stats | undefined): number | null {
  const load = s?.cpu?.loadAvg?.[0]
  const cores = s?.cpu?.cores
  if (load == null || cores == null || cores <= 0) return null
  return (load / cores) * 100
}

export function StatsGrid() {
  const { t } = useTranslation('dashboard')

  function reachability(reachable: boolean | undefined): string | undefined {
    if (reachable == null) return undefined
    return reachable ? t('stats.connected') : t('stats.disconnected')
  }

  const { data, isLoading, isError, error, isFetching } = useQuery<Stats>({
    queryKey: ['stats'],
    queryFn: ({ signal }) => api.system.stats(signal),
    refetchInterval: POLL_MS,
  })

  // Initial load only — keep showing last good data while refetching.
  const loading = isLoading

  if (isError && !data) {
    const message =
      error instanceof ApiRequestError
        ? error.message
        : t('stats.loadError')
    return (
      <Alert type="warning" showIcon>
        {message}
      </Alert>
    )
  }

  const memPct = pct(data?.memory?.usedBytes, data?.memory?.totalBytes)
  const diskPct = pct(data?.disk?.usedBytes, data?.disk?.totalBytes)
  const cores = data?.cpu?.cores

  return (
    <div className="space-y-4">
      {/* Resource usage gauges */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={t('stats.cpu')}
          value={cpuPct(data) == null ? '—' : `${Math.round(cpuPct(data) as number)}%`}
          hint={cores ? t('stats.cores', { count: cores }) : undefined}
          percent={cpuPct(data)}
          loading={loading}
        />
        <StatCard
          label={t('stats.memory')}
          value={memPct == null ? '—' : `${Math.round(memPct)}%`}
          hint={
            data?.memory
              ? `${formatBytes(data.memory.usedBytes)} / ${formatBytes(data.memory.totalBytes)}`
              : undefined
          }
          percent={memPct}
          loading={loading}
        />
        <StatCard
          label={t('stats.disk')}
          value={
            data && data.disk == null
              ? t('stats.diskNA')
              : diskPct == null
                ? '—'
                : `${Math.round(diskPct)}%`
          }
          hint={
            data?.disk
              ? `${formatBytes(data.disk.usedBytes)} / ${formatBytes(data.disk.totalBytes)}`
              : undefined
          }
          percent={diskPct}
          loading={loading}
        />
      </div>

      {/* Operational counts */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label={t('stats.activeStreams')}
          value={data?.counts?.activeStreams ?? 0}
          loading={loading}
        />
        <StatCard label={t('stats.apps')} value={data?.counts?.apps ?? 0} loading={loading} />
        <StatCard label={t('stats.rooms')} value={data?.counts?.rooms ?? 0} loading={loading} />
        <StatCard
          label={t('stats.ingress')}
          value={`${data?.ingress?.active ?? 0} / ${data?.ingress?.total ?? 0}`}
          hint={reachability(data?.ingress?.reachable)}
          loading={loading}
        />
        <StatCard
          label={t('stats.egress')}
          value={`${data?.egress?.active ?? 0} / ${data?.egress?.total ?? 0}`}
          hint={reachability(data?.egress?.reachable)}
          loading={loading}
        />
      </div>

      {/* Storage — DB footprint + recorded VOD bytes */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label={t('stats.database')}
          value={formatBytes(data?.storage?.totalDbSizeBytes)}
          hint={t('stats.databaseHint')}
          loading={loading}
        />
        <StatCard
          label={t('stats.vodStorage')}
          value={formatBytes(data?.storage?.vodTotalBytes)}
          hint={
            data?.storage
              ? t('stats.vods', { count: data.storage.vodCount })
              : undefined
          }
          loading={loading}
        />
      </div>

      {/* LiveKit reachability footnote */}
      {data && (
        <div className="flex items-center gap-2 px-1 text-xs text-slate-500">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              data.livekitReachable ? 'bg-emerald-400' : 'bg-red-400'
            }`}
          />
          LiveKit{' '}
          {data.livekitReachable
            ? t('stats.livekitReachable')
            : t('stats.livekitUnreachable')}
          {isFetching && (
            <span className="ml-2 text-slate-600">· {t('stats.updating')}</span>
          )}
        </div>
      )}
    </div>
  )
}
