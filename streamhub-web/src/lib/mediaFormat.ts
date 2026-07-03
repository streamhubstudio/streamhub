/**
 * Pure media formatting helpers (duration / bitrate) + tolerant field pickers
 * for the VOD wire shape. Dependency-free (no React, no api client) so the
 * mapping is unit-testable under node:test.
 *
 * The backend VodRecord speaks `durationS` + `startedAt`; older UI code (and
 * some legacy rows) used `durationSeconds` + `createdAt`. The pickers accept
 * both so Grabaciones always shows duration + date regardless of the origin.
 */

const DASH = '—'

/** Seconds → `m:ss` or `h:mm:ss`. Unknown/invalid → em dash. */
export function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return DASH
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (x: number) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Bits-per-second → human bitrate (`2.5 Mbps`, `800 kbps`). Unknown → dash. */
export function formatBitrate(bps?: number | null): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return DASH
  if (bps >= 1_000_000) {
    const mbps = bps / 1_000_000
    return `${mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)} Mbps`
  }
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} kbps`
  return `${Math.round(bps)} bps`
}

/** VOD duration in seconds, tolerating both wire spellings. */
export function vodDurationS(v: {
  durationS?: number | null
  durationSeconds?: number | null
}): number | undefined {
  const raw = v.durationS ?? v.durationSeconds
  return raw == null || !Number.isFinite(Number(raw)) || Number(raw) <= 0
    ? undefined
    : Number(raw)
}

/** VOD creation timestamp (backend `startedAt`, legacy `createdAt`). */
export function vodStartedAt(v: {
  startedAt?: string | null
  createdAt?: string | null
}): string | undefined {
  return v.startedAt ?? v.createdAt ?? undefined
}

/** ISO (or SQLite datetime) → locale string; unparseable input verbatim. */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return DASH
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}
