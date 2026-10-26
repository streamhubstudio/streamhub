/**
 * Network I/O card (Wave 1C) — per-app media-plane byte accounting on the main
 * dashboard overview. Shows Network In / Out today for a selected app (or the
 * "All apps" aggregate), a 24h sparkline from the history endpoint, a threshold
 * ok/exceeded pill, and a link to the app's settings. Polls every 15s.
 *
 * Data: GET /apps/:app/net (+ /net/history) per app via `useQueries`; the app
 * list drives both the selector and the aggregate. All math is delegated to the
 * pure `@/lib/netMetrics` helpers (unit-tested under node:test).
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueries, useQuery } from '@tanstack/react-query'
import { api, type App, type NetHistory, type NetSummary } from '@/api'
import { Card } from '@/ui'
import { formatBytes } from '@/lib/bytes'
import {
  aggregateSummaries,
  bucketTotals,
  mergeHistoryBuckets,
  sparklinePoints,
} from '@/lib/netMetrics'

const POLL_MS = 15_000
const ALL = '__all__'
const SPARK_W = 240
const SPARK_H = 40

interface AppNet {
  name: string
  summary: NetSummary
  history: NetHistory
}

export function NetworkCard() {
  const { t } = useTranslation('dashboard')
  const [scope, setScope] = useState<string>(ALL)

  const { data: apps } = useQuery<App[]>({
    queryKey: ['apps'],
    queryFn: ({ signal }) => api.apps.list(signal),
    refetchInterval: 30_000,
  })
  const appNames = (apps ?? []).map((a) => a.name)

  const results = useQueries({
    queries: appNames.map((name) => ({
      queryKey: ['net', name],
      queryFn: ({ signal }: { signal?: AbortSignal }): Promise<AppNet> =>
        Promise.all([
          api.apps.net(name, signal),
          api.apps.netHistory(name, 24, signal),
        ]).then(([summary, history]) => ({ name, summary, history })),
      refetchInterval: POLL_MS,
    })),
  })

  const loaded = results.filter((r) => r.data).map((r) => r.data as AppNet)
  const isLoading = appNames.length > 0 && loaded.length === 0

  // Resolve the selected scope → { in/out today, sparkline totals, threshold }.
  const view = buildView(scope, loaded)

  const totals = bucketTotals(view.history)
  const points = sparklinePoints(totals, SPARK_W, SPARK_H)
  const tone = view.exceeded ? 'crit' : 'ok'

  return (
    <Card bordered bodyClass="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">
            {t('net.title')}
          </div>
          <p className="text-xs text-slate-500">{t('net.subtitle')}</p>
        </div>
        <select
          aria-label={t('net.appLabel')}
          data-testid="net-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="rounded-md border border-gray-300 bg-transparent px-2 py-1 text-xs text-fg dark:border-gray-700"
        >
          <option value={ALL}>{t('net.allApps')}</option>
          {appNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {appNames.length === 0 ? (
        <div className="py-6 text-center text-sm text-slate-500">
          {t('net.empty')}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="grid grid-cols-2 gap-4">
              <Metric
                label={t('net.in')}
                value={isLoading ? '—' : formatBytes(view.today.in)}
              />
              <Metric
                label={t('net.out')}
                value={isLoading ? '—' : formatBytes(view.today.out)}
              />
            </div>
            <ThresholdPill
              label={
                view.exceeded
                  ? scope === ALL
                    ? t('net.exceededCount', { count: view.exceededCount })
                    : t('net.exceeded')
                  : view.hasThreshold || scope === ALL
                    ? t('net.ok')
                    : t('net.noThreshold')
              }
              tone={view.hasThreshold || scope === ALL ? tone : 'muted'}
            />
          </div>

          {/* 24h sparkline (total bytes/hour) */}
          <div className="mt-3" data-testid="net-spark">
            {points ? (
              <svg
                viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                preserveAspectRatio="none"
                className="h-10 w-full"
                role="img"
                aria-label={t('net.sparkAria')}
              >
                <polyline
                  points={points}
                  fill="none"
                  strokeWidth={1.5}
                  className={
                    tone === 'crit'
                      ? 'stroke-red-400'
                      : 'stroke-sky-400 dark:stroke-sky-500'
                  }
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            ) : (
              <div className="h-10" />
            )}
          </div>

          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>{t('net.last24h')}</span>
            {scope !== ALL && (
              <Link
                to={`/apps/${encodeURIComponent(scope)}`}
                className="text-primary-500 transition hover:text-fg"
              >
                {t('net.configure')} →
              </Link>
            )}
          </div>
        </>
      )}
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums text-fg">{value}</div>
    </div>
  )
}

function ThresholdPill({
  label,
  tone,
}: {
  label: string
  tone: 'ok' | 'crit' | 'muted'
}) {
  const cls =
    tone === 'crit'
      ? 'bg-red-500/15 text-red-300'
      : tone === 'ok'
        ? 'bg-emerald-500/15 text-emerald-300'
        : 'bg-slate-500/15 text-slate-400'
  return (
    <span
      data-testid="net-threshold"
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${cls}`}
    >
      {label}
    </span>
  )
}

interface CardView {
  today: { in: number; out: number; total: number }
  history: NetHistory['buckets']
  exceeded: boolean
  exceededCount: number
  hasThreshold: boolean
}

/** Fold the loaded per-app data down to the selected scope's view model. */
function buildView(scope: string, loaded: AppNet[]): CardView {
  if (scope === ALL) {
    const agg = aggregateSummaries(loaded.map((r) => r.summary))
    return {
      today: agg.today,
      history: mergeHistoryBuckets(loaded.map((r) => r.history.buckets)),
      exceeded: agg.exceededCount > 0,
      exceededCount: agg.exceededCount,
      hasThreshold: false,
    }
  }
  const one = loaded.find((r) => r.name === scope)
  if (!one) {
    return {
      today: { in: 0, out: 0, total: 0 },
      history: [],
      exceeded: false,
      exceededCount: 0,
      hasThreshold: false,
    }
  }
  return {
    today: one.summary.today,
    history: one.history.buckets,
    exceeded: one.summary.threshold.exceeded,
    exceededCount: one.summary.threshold.exceeded ? 1 : 0,
    hasThreshold: one.summary.threshold.gbPerDay > 0,
  }
}
