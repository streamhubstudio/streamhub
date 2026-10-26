/**
 * Pure helpers for the dashboard Network I/O card (Wave 1C). No React, no DOM —
 * window aggregation across apps, hourly-bucket merging, and SVG sparkline
 * geometry. Kept here (src/lib) so the fast `node --test` logic suite can lock
 * the math without mounting a component.
 */
import type { NetHistoryBucket, NetSummary, NetWindow } from '@/api'

/** Sum two byte windows. */
export function addWindows(a: NetWindow, b: NetWindow): NetWindow {
  return { in: a.in + b.in, out: a.out + b.out, total: a.total + b.total }
}

const ZERO: NetWindow = { in: 0, out: 0, total: 0 }

/** Aggregate rollup across a set of per-app summaries (the "All apps" view). */
export interface AggregateNet {
  today: NetWindow
  last24h: NetWindow
  last7d: NetWindow
  /** How many of the aggregated apps are currently over their threshold. */
  exceededCount: number
}

/** Fold per-app summaries into one aggregate (used for the "All apps" option). */
export function aggregateSummaries(list: NetSummary[]): AggregateNet {
  return list.reduce<AggregateNet>(
    (acc, s) => ({
      today: addWindows(acc.today, s.today),
      last24h: addWindows(acc.last24h, s.last24h),
      last7d: addWindows(acc.last7d, s.last7d),
      exceededCount: acc.exceededCount + (s.threshold.exceeded ? 1 : 0),
    }),
    { today: ZERO, last24h: ZERO, last7d: ZERO, exceededCount: 0 },
  )
}

/**
 * Merge multiple apps' history buckets into one series keyed by bucket
 * (summing in/out per hour), sorted ascending by bucket.
 */
export function mergeHistoryBuckets(
  series: NetHistoryBucket[][],
): NetHistoryBucket[] {
  const byBucket = new Map<string, NetHistoryBucket>()
  for (const buckets of series) {
    for (const b of buckets) {
      const e = byBucket.get(b.bucket) ?? { bucket: b.bucket, in: 0, out: 0 }
      e.in += b.in
      e.out += b.out
      byBucket.set(b.bucket, e)
    }
  }
  return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))
}

/** Total (in+out) bytes per bucket, in bucket order. */
export function bucketTotals(buckets: NetHistoryBucket[]): number[] {
  return buckets.map((b) => b.in + b.out)
}

/**
 * SVG polyline `points` for a sparkline over `values`, fitted to a `width`×
 * `height` box (y inverted so larger = higher). Normalized to the series max;
 * a flat/empty series renders along the baseline. Returns '' for < 2 points.
 */
export function sparklinePoints(
  values: number[],
  width: number,
  height: number,
): string {
  if (values.length < 2 || width <= 0 || height <= 0) return ''
  const max = Math.max(...values)
  const stepX = width / (values.length - 1)
  return values
    .map((v, i) => {
      const x = i * stepX
      const y = max > 0 ? height - (v / max) * height : height
      return `${round(x)},${round(y)}`
    })
    .join(' ')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
