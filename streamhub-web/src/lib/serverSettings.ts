/**
 * Pure helpers for the read-only "Server settings" page — badge tones and a
 * compact uptime formatter. Kept dependency-free so they run under node:test.
 */
import type { AuthzEnforce } from '@/api'

export type Tone = 'green' | 'amber' | 'red'

/**
 * Badge tone for the permission-enforcement mode:
 *   on  → green (enforced), log → amber (audit-only, "no aplica"),
 *   off → red (checks disabled). Unknown values degrade to amber.
 */
export function authzTone(mode: AuthzEnforce | string | undefined): Tone {
  if (mode === 'on') return 'green'
  if (mode === 'off') return 'red'
  return 'amber' // 'log' and anything unexpected
}

/** True only when permission checks actually block (mode === 'on'). */
export function enforcementActive(mode: AuthzEnforce | string | undefined): boolean {
  return mode === 'on'
}

/** Badge tone for a "…Set" boolean: configured → green, unset → red. */
export function setTone(isSet: boolean): Tone {
  return isSet ? 'green' : 'red'
}

/**
 * Compact human uptime, e.g. 90 → "1m 30s", 3661 → "1h 1m", 90061 → "1d 1h".
 * Shows at most the two most-significant non-zero units. Non-finite/negative
 * inputs render as "—".
 */
export function formatUptime(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  if (sec || parts.length === 0) parts.push(`${sec}s`)
  return parts.slice(0, 2).join(' ')
}
