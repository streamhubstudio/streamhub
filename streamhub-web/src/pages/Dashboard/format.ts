/**
 * Small formatting helpers for the Dashboard.
 * Pure functions — no React, easy to reason about.
 */

// Human-readable bytes lives in the shared lib now (also used by AppDetail).
export { formatBytes } from '@/lib/bytes'

/** Clamp a number into the inclusive [min, max] range. */
export function clamp(n: number, min = 0, max = 100): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** Compact uptime, e.g. "2d 3h", "4h 12m", "39s". */
export function formatUptime(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

/** Percent string with one decimal when meaningful. */
export function formatPercent(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  const v = clamp(pct)
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`
}

/** Short date for the apps table (locale-aware, falls back to raw). */
export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  })
}

/** Threshold tone used by usage bars: ok (<70) / warn (70–90) / crit (>=90). */
export type UsageTone = 'ok' | 'warn' | 'crit'

export function usageTone(pct: number | null | undefined): UsageTone {
  if (pct == null || !Number.isFinite(pct)) return 'ok'
  if (pct >= 90) return 'crit'
  if (pct >= 70) return 'warn'
  return 'ok'
}
