/**
 * Pure DVR/timeshift helpers (G5 — streamhub-docs/features/dvr-clips.md),
 * dependency-free → node:test-able. The <HlsPlayer dvr> UI and the public
 * /play + /embed pages build on these.
 *
 * The server writes `dvr.m3u8`: a sliding window over the live HLS (last
 * `windowMinutes`) where every segment carries an EXT-X-PROGRAM-DATE-TIME, so
 * a wall-clock instant maps onto the player timeline.
 *
 * `?t=` (the deep link into the window) accepts two forms — chosen so an
 * EVENT can link to the moment it happened and a human can say "5 minutes
 * ago":
 *   - ABSOLUTE instant: unix epoch seconds (`1730200000`), epoch ms
 *     (`1730200000123`) or ISO-8601 (`2026-10-29T14:03:00Z`);
 *   - RELATIVE to the live edge: a leading `-` with seconds or h/m/s units
 *     (`-90`, `-5m`, `-1h30m`, `-45s`).
 * Anything else is ignored (the player starts at the live edge). A target
 * outside the window is clamped to it (and reported as such).
 */

/** Where `?t=` asks playback to start. */
export type DvrStartAt =
  | { kind: 'epoch'; epochMs: number }
  | { kind: 'offset'; seconds: number }

/** Name of the server-written sliding-window playlist. */
export const DVR_PLAYLIST = 'dvr.m3u8'

const RELATIVE_RE = /^-(?:(\d+(?:\.\d+)?)|(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?)$/
/** Epoch seconds below this are not plausible instants (2001-09-09). */
const MIN_EPOCH_S = 1_000_000_000
/** At or above this a bare number is epoch MILLISECONDS. */
const MIN_EPOCH_MS = 100_000_000_000

/** Parse a `?t=` value; null when absent or not one of the documented forms. */
export function parseDvrStartAt(raw: string | null | undefined): DvrStartAt | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  if (v.startsWith('-')) {
    const m = RELATIVE_RE.exec(v)
    if (!m || v === '-') return null
    const seconds = m[1] !== undefined
      ? Number(m[1])
      : Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)
    return Number.isFinite(seconds) && seconds > 0 ? { kind: 'offset', seconds } : null
  }
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v)
    if (!Number.isFinite(n) || n < MIN_EPOCH_S) return null
    return { kind: 'epoch', epochMs: n >= MIN_EPOCH_MS ? Math.round(n) : Math.round(n * 1000) }
  }
  // ISO-8601 only (Date.parse also takes free text like "March 7" — refuse it).
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return null
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : { kind: 'epoch', epochMs: ms }
}

/** `?t=` value for a wall-clock instant (epoch seconds — the event-link form). */
export function formatDvrStartAt(epochMs: number): string {
  return String(Math.floor(epochMs / 1000))
}

/** The seekable range of the player, in media seconds. */
export interface SeekWindow {
  start: number
  end: number
}

/**
 * A segment as the HLS engine exposes it (video.js VHS): `start` on the media
 * timeline once timed, and its PROGRAM-DATE-TIME.
 */
export interface TimedSegmentLike {
  start?: number
  dateTimeObject?: Date
  programDateTime?: number
}

/**
 * Epoch ms of media time 0, from the first segment that carries both a media
 * `start` and a PROGRAM-DATE-TIME; null when the playlist has no PDT yet.
 */
export function pdtEpochAtZero(segments: readonly TimedSegmentLike[] | null | undefined): number | null {
  for (const s of segments ?? []) {
    if (typeof s.start !== 'number' || !Number.isFinite(s.start)) continue
    const pdt = s.dateTimeObject ? s.dateTimeObject.getTime() : s.programDateTime
    if (typeof pdt === 'number' && Number.isFinite(pdt)) return pdt - s.start * 1000
  }
  return null
}

function clamp(n: number, w: SeekWindow): number {
  return Math.min(Math.max(n, w.start), w.end)
}

/** The seek target for a `?t=`, and whether it fell outside the window. */
export interface SeekTarget {
  time: number
  clamped: boolean
}

/**
 * Resolve a start request onto the window. An epoch maps through the
 * PROGRAM-DATE-TIME anchor (`epochAtZero`); without one it falls back to
 * "now - instant" behind the live edge (approximate by the HLS latency).
 */
export function resolveSeekTarget(
  at: DvrStartAt,
  win: SeekWindow,
  epochAtZero: number | null,
  nowMs: number,
): SeekTarget | null {
  if (!(Number.isFinite(win.start) && Number.isFinite(win.end)) || win.end < win.start) return null
  let want: number
  if (at.kind === 'offset') {
    want = win.end - at.seconds
  } else if (epochAtZero !== null) {
    want = (at.epochMs - epochAtZero) / 1000
  } else {
    want = win.end - (nowMs - at.epochMs) / 1000
  }
  const time = clamp(want, win)
  return { time, clamped: Math.abs(time - want) > 0.001 }
}

/** Wall-clock epoch ms of a media time (null without a PDT anchor). */
export function mediaTimeToEpoch(time: number, epochAtZero: number | null): number | null {
  return epochAtZero === null || !Number.isFinite(time) ? null : epochAtZero + time * 1000
}

/**
 * Is playback at the live edge? Within `toleranceS` (default: two segments
 * of a typical 4 s, which absorbs the engine's own live-edge back-off).
 */
export function isAtLiveEdge(current: number, win: SeekWindow, toleranceS = 8): boolean {
  return win.end - current <= toleranceS
}

/** `-1:02:03` / `-05:07` behind the live edge; '' at (or past) the edge. */
export function formatBehindLive(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return ''
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `-${h}:${mm}:${ss}` : `-${mm}:${ss}`
}

/** `HH:MM:SS` wall clock of an epoch ms (optional IANA zone; '' when unknown). */
export function formatWallClock(epochMs: number | null, timeZone?: string): string {
  if (epochMs === null || !Number.isFinite(epochMs)) return ''
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(epochMs))
  } catch {
    return new Date(epochMs).toISOString().slice(11, 19)
  }
}

/** `/hls/<app>/<room>/dvr.m3u8` — the rewindable playlist (relative path). */
export function dvrPlaylistPath(app: string, room: string): string {
  return `/hls/${encodeURIComponent(app)}/${encodeURIComponent(room)}/${DVR_PLAYLIST}`
}

/** Append/replace `t=` on a page URL (keeps every other query param). */
export function withStartAt(url: string, t: string): string {
  const [base, hash = ''] = url.split('#', 2)
  const [path, query = ''] = base.split('?', 2)
  const params = new URLSearchParams(query)
  params.set('t', t)
  return `${path}?${params.toString()}${hash ? `#${hash}` : ''}`
}
