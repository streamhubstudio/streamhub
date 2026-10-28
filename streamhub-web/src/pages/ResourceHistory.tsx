/**
 * Resource history — superadmin view of the in-app host resource-usage history
 * (CPU / RAM / Network / Disk) sampled once per hour into the global DB, 30-day
 * retention. Four hand-rolled dot charts over a selectable window (default 30d).
 *
 * This is the LIGHTWEIGHT, dependency-free path — complementary to the
 * Prometheus/Grafana stack (`/metrics`), which is the heavyweight option.
 * Global-scope surface: a 403 degrades to a friendly notice, a 404 (core
 * predates the feature) explains it isn't available. Data via
 * @tanstack/react-query + the typed `api` client.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  api,
  ApiRequestError,
  type MetricsHistoryRange,
  type MetricsHistoryResponse,
} from '@/api'
import { Alert, Card, Skeleton } from '@/ui'
import { DotChart } from '@/components/DotChart'
import { formatBytes } from '@/lib/bytes'
import type { DotPoint } from '@/lib/dotchart'

const POLL_MS = 5 * 60_000
const RANGES: MetricsHistoryRange[] = ['24h', '7d', '30d', '90d']

const RANGE_MS: Record<MetricsHistoryRange, number> = {
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
  '90d': 90 * 24 * 60 * 60_000,
}

const pctY = (v: number): string => `${Math.round(v)}%`
const bytesRateY = (v: number): string => `${formatBytes(v)}`

function useXFormatter(range: MetricsHistoryRange, lang: string) {
  return useMemo(() => {
    const opts: Intl.DateTimeFormatOptions =
      range === '24h'
        ? { hour: '2-digit', minute: '2-digit' }
        : { month: 'short', day: 'numeric' }
    const fmt = new Intl.DateTimeFormat(lang || undefined, opts)
    return (ts: number) => fmt.format(new Date(ts))
  }, [range, lang])
}

/** Latest finite value of a series, for the card's headline figure. */
function latest(points: DotPoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i].value
    if (v != null && Number.isFinite(v)) return v
  }
  return null
}

interface ChartCardProps {
  title: string
  hint: string
  headline: string
  points: DotPoint[]
  domain: { start: number; end: number }
  yMax?: number
  formatY: (v: number) => string
  formatX: (ts: number) => string
  accentClass: string
  emptyLabel: string
}

function ChartCard({
  title,
  hint,
  headline,
  points,
  domain,
  yMax,
  formatY,
  formatX,
  accentClass,
  emptyLabel,
}: ChartCardProps) {
  return (
    <Card bordered bodyClass="px-5 py-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p>
        </div>
        <span className={`text-lg font-semibold tabular-nums ${accentClass}`}>
          {headline}
        </span>
      </div>
      <DotChart
        points={points}
        domain={domain}
        yMax={yMax}
        formatY={formatY}
        formatX={formatX}
        accentClass={accentClass}
        ariaLabel={title}
        emptyLabel={emptyLabel}
      />
    </Card>
  )
}

export default function ResourceHistory() {
  const { t, i18n } = useTranslation('resourceHistory')
  const [range, setRange] = useState<MetricsHistoryRange>('30d')

  const q = useQuery<MetricsHistoryResponse>({
    queryKey: ['metrics-history', range],
    queryFn: ({ signal }) => api.system.metricsHistory({ range }, signal),
    refetchInterval: POLL_MS,
    retry: (count, err) =>
      !(err instanceof ApiRequestError && [403, 404].includes(err.status)) &&
      count < 2,
  })

  const formatX = useXFormatter(range, i18n.language)

  const forbidden = q.error instanceof ApiRequestError && q.error.status === 403
  const notFound = q.error instanceof ApiRequestError && q.error.status === 404

  // Shared x domain: [now - window, now] so every chart lines up.
  const now = q.data?.now ?? Date.now()
  const domain = { start: now - RANGE_MS[range], end: now }

  const cpu: DotPoint[] = (q.data?.series.cpu ?? []).map((p) => ({
    ts: p.ts,
    value: p.value,
  }))
  const mem: DotPoint[] = (q.data?.series.mem ?? []).map((p) => ({
    ts: p.ts,
    value: p.pct,
  }))
  const disk: DotPoint[] = (q.data?.series.disk ?? []).map((p) => ({
    ts: p.ts,
    value: p.value,
  }))
  // Network throughput per bucket = rx + tx (null when the counters are absent).
  const net: DotPoint[] = (q.data?.series.net ?? []).map((p) => ({
    ts: p.ts,
    value: p.rx == null && p.tx == null ? null : (p.rx ?? 0) + (p.tx ?? 0),
  }))

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fg">{t('title')}</h1>
          <p className="text-sm text-slate-400">{t('subtitle')}</p>
        </div>
        <RangeSwitcher range={range} onChange={setRange} />
      </div>

      <Alert type="info" showIcon>
        {t('lightweightNote')}
      </Alert>

      {forbidden ? (
        <Alert type="warning" showIcon>
          {t('forbidden')}
        </Alert>
      ) : notFound ? (
        <Alert type="warning" showIcon>
          {t('notAvailable')}
        </Alert>
      ) : q.isError ? (
        <Alert type="danger" showIcon>
          {t('loadError')}
        </Alert>
      ) : q.isLoading || !q.data ? (
        <LoadingState />
      ) : (
        <>
          {q.data.retentionDays > 0 && (
            <p className="text-xs text-fg-subtle">
              {t('retentionNote', { days: q.data.retentionDays })}
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard
              title={t('cpu.title')}
              hint={t('cpu.hint')}
              headline={fmtHeadline(latest(cpu), pctY)}
              points={cpu}
              domain={domain}
              yMax={100}
              formatY={pctY}
              formatX={formatX}
              accentClass="text-primary-500"
              emptyLabel={t('empty')}
            />
            <ChartCard
              title={t('mem.title')}
              hint={t('mem.hint')}
              headline={fmtHeadline(latest(mem), pctY)}
              points={mem}
              domain={domain}
              yMax={100}
              formatY={pctY}
              formatX={formatX}
              accentClass="text-emerald-500"
              emptyLabel={t('empty')}
            />
            <ChartCard
              title={t('net.title')}
              hint={t('net.hint')}
              headline={fmtHeadline(latest(net), bytesRateY)}
              points={net}
              domain={domain}
              formatY={bytesRateY}
              formatX={formatX}
              accentClass="text-sky-500"
              emptyLabel={t('emptyNet')}
            />
            <ChartCard
              title={t('disk.title')}
              hint={t('disk.hint')}
              headline={fmtHeadline(latest(disk), pctY)}
              points={disk}
              domain={domain}
              yMax={100}
              formatY={pctY}
              formatX={formatX}
              accentClass="text-amber-500"
              emptyLabel={t('emptyDisk')}
            />
          </div>
        </>
      )}
    </div>
  )
}

function fmtHeadline(value: number | null, fmt: (v: number) => string): string {
  return value == null ? '—' : fmt(value)
}

function RangeSwitcher({
  range,
  onChange,
}: {
  range: MetricsHistoryRange
  onChange: (r: MetricsHistoryRange) => void
}) {
  const { t } = useTranslation('resourceHistory')
  return (
    <div
      role="group"
      aria-label={t('rangeLabel')}
      className="inline-flex rounded-lg border border-border bg-surface p-0.5"
    >
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={[
            'rounded-md px-3 py-1.5 text-xs font-medium transition',
            r === range
              ? 'bg-primary-500/10 ring-1 ring-primary-500/30 text-primary-400'
              : 'text-fg-muted hover:bg-surface-raised hover:text-fg',
          ].join(' ')}
        >
          {t(`range.${r}`)}
        </button>
      ))}
    </div>
  )
}

function LoadingState() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <Card bordered key={i} bodyClass="px-5 py-4">
          <Skeleton height={18} className="mb-4 w-32" />
          <Skeleton height={160} />
        </Card>
      ))}
    </div>
  )
}
