/**
 * Generic metric card. Two flavours:
 *  - usage gauge: pass `percent` (0–100) to render a tinted progress bar.
 *  - plain count: omit `percent` and pass a `value` + optional `hint`.
 */
import type { ReactNode } from 'react'
import { Card } from '@/ui'
import { clamp, formatPercent, usageTone, type UsageTone } from './format'

interface StatCardProps {
  label: string
  value: ReactNode
  hint?: string
  /** When provided (0–100), renders a usage bar tinted by threshold. */
  percent?: number | null
  /** Dim the card while the underlying query is still resolving. */
  loading?: boolean
}

const BAR_TONE: Record<UsageTone, string> = {
  ok: 'from-sky2 to-blue2',
  warn: 'from-amber-400 to-amber-500',
  crit: 'from-red-400 to-red-500',
}

const VALUE_TONE: Record<UsageTone, string> = {
  ok: 'text-fg',
  warn: 'text-amber-300',
  crit: 'text-red-300',
}

export function StatCard({ label, value, hint, percent, loading }: StatCardProps) {
  const hasGauge = percent != null && Number.isFinite(percent)
  const tone = hasGauge ? usageTone(percent) : 'ok'
  const width = hasGauge ? clamp(percent as number) : 0

  return (
    <Card bordered bodyClass="px-5 py-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>

      <div className="mt-2 flex items-baseline gap-2">
        <span
          className={[
            'text-2xl font-semibold tabular-nums',
            hasGauge ? VALUE_TONE[tone] : 'text-fg',
            loading ? 'opacity-40' : '',
          ].join(' ')}
        >
          {loading ? '—' : value}
        </span>
        {hint && !loading && (
          <span className="text-xs text-slate-500">{hint}</span>
        )}
      </div>

      {hasGauge && (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className={`h-full rounded-full bg-gradient-to-r ${BAR_TONE[tone]} transition-[width] duration-500`}
              style={{ width: `${loading ? 0 : width}%` }}
            />
          </div>
          {!loading && (
            <div className="mt-1 text-right text-[11px] text-slate-500">
              {formatPercent(percent)}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
