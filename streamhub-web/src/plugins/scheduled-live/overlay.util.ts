/**
 * Pure helpers for the Scheduled Live overlay.
 *
 * Framework-agnostic (no React, no DOM) so every branch is unit-tested with
 * Node's built-in runner — the overlay component (index.tsx) is a thin shell
 * around these. This is where the timezone math + the countdown/reveal phase
 * machine live; the component only wires a clock, a poll and the DOM.
 *
 * TIMEZONE MODEL: the operator picks a WALL time in an IANA zone in the browser;
 * `zonedWallTimeToUtcMs` converts it to an absolute UTC instant (ms) which is
 * what the backend stores. The player never re-does timezone math — it compares
 * `startAt` (absolute ms) against `Date.now()`.
 */
import type { ConfigValues } from '../types.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A scheduled event as returned by the agenda API (camelCase, absolute ms). */
export interface ScheduledEvent {
  id: number
  room: string | null
  title: string | null
  /** Absolute reveal instant — unix epoch MILLISECONDS, UTC. */
  startAt: number
  timezone: string
  message: string | null
  enabled?: boolean
}

/** A picked wall-clock time (calendar fields, no zone). */
export interface WallTime {
  year: number
  /** 1-12 (human month). */
  month: number
  day: number
  hour: number
  minute: number
  second?: number
}

export type OverlayPhase = 'idle' | 'countdown' | 'reveal'
export type OverlayMode = 'cover' | 'badge'
export type RevealAnimation = 'fade' | 'zoom' | 'none'

export const DEFAULT_ACCENT = '#2f7bff'
export const DEFAULT_HEADLINE = 'The live stream starts soon'
export const DEFAULT_AUTO_HIDE_SEC = 5

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

// ---------------------------------------------------------------------------
// Timezone math (Intl guess-and-correct)
// ---------------------------------------------------------------------------

/** Parse the numeric wall-clock parts an Intl formatter emits for an instant. */
function zonedParts(timeZone: string, utcMs: number): Required<WallTime> {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const map: Record<string, number> = {}
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') map[p.type] = Number(p.value)
  }
  // en-US hour12:false renders midnight as "24" in some engines — normalize.
  const hour = map.hour === 24 ? 0 : map.hour
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour,
    minute: map.minute,
    second: map.second,
  }
}

/**
 * Offset of `timeZone` at the given absolute instant, in MILLISECONDS
 * (wallClock − UTC). Positive = ahead of UTC. Invalid zones fall back to 0 (UTC).
 */
export function tzOffsetMsAt(timeZone: string, utcMs: number): number {
  try {
    const p = zonedParts(timeZone, utcMs)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    return asUtc - utcMs
  } catch {
    return 0
  }
}

/**
 * Convert a picked wall time in `timeZone` to the absolute UTC instant (ms).
 * Standard guess-and-correct: treat the wall time as if it were UTC, read the
 * zone's offset at that guess, correct once, then re-check across a possible DST
 * boundary. Handles fixed-offset (Buenos Aires) and DST (New York) zones alike.
 */
export function zonedWallTimeToUtcMs(wall: WallTime, timeZone: string): number {
  const { year, month, day, hour, minute, second = 0 } = wall
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const off1 = tzOffsetMsAt(timeZone, guess)
  let utc = guess - off1
  const off2 = tzOffsetMsAt(timeZone, utc)
  if (off2 !== off1) utc = guess - off2
  return utc
}

/** The wall-clock parts of an absolute instant, as seen in `timeZone`. */
export function utcMsToZonedParts(ms: number, timeZone: string): Required<WallTime> {
  return zonedParts(timeZone, ms)
}

/** A short UTC-offset label for a zone at an instant, e.g. "GMT-03". */
export function formatOffsetLabel(timeZone: string, ms: number): string {
  const totalMin = Math.round(tzOffsetMsAt(timeZone, ms) / 60000)
  const sign = totalMin < 0 ? '-' : '+'
  const abs = Math.abs(totalMin)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `GMT${sign}${pad2(h)}${m ? `:${pad2(m)}` : ''}`
}

// ---------------------------------------------------------------------------
// Phase machine
// ---------------------------------------------------------------------------

/** Does an event target this room? (its room matches, or it's global). */
export function matchesRoom(event: ScheduledEvent, room: string | undefined): boolean {
  if (!event.room) return true // global event → every room
  if (!room) return true // no room context → can't discriminate, keep it
  return event.room === room
}

/**
 * The event that should currently drive the overlay:
 *   1. a premiere that JUST started (start_at ≤ now < start_at + autoHideMs) —
 *      reveal has precedence so the freshly-started stream is shown (most-recent
 *      such start wins), even if a later event is also scheduled;
 *   2. otherwise the SOONEST still-future event (drives the countdown).
 * Disabled events and events for another room are ignored.
 */
export function pickActiveEvent(
  events: ScheduledEvent[],
  room: string | undefined,
  nowMs: number,
  autoHideMs = 0,
): ScheduledEvent | undefined {
  const relevant = events.filter((e) => e.enabled !== false && matchesRoom(e, room))

  let reveal: ScheduledEvent | undefined
  for (const e of relevant) {
    if (e.startAt <= nowMs && nowMs < e.startAt + autoHideMs) {
      if (!reveal || e.startAt > reveal.startAt) reveal = e
    }
  }
  if (reveal) return reveal

  let soonest: ScheduledEvent | undefined
  for (const e of relevant) {
    if (e.startAt > nowMs && (!soonest || e.startAt < soonest.startAt)) soonest = e
  }
  return soonest
}

export interface PhaseResult {
  phase: OverlayPhase
  event: ScheduledEvent | undefined
  /** countdown → ms until start; reveal → ms until the reveal window ends; idle → 0. */
  remainingMs: number
}

/**
 * Resolve the overlay phase for the active event:
 *   - `countdown` while now < start_at,
 *   - `reveal` while start_at ≤ now < start_at + autoHideMs,
 *   - `idle` otherwise (no event, or the reveal window elapsed).
 */
export function computePhase(
  events: ScheduledEvent[],
  room: string | undefined,
  nowMs: number,
  autoHideMs: number,
): PhaseResult {
  const event = pickActiveEvent(events, room, nowMs, autoHideMs)
  if (!event) return { phase: 'idle', event: undefined, remainingMs: 0 }
  if (nowMs < event.startAt) {
    return { phase: 'countdown', event, remainingMs: event.startAt - nowMs }
  }
  if (nowMs < event.startAt + autoHideMs) {
    return { phase: 'reveal', event, remainingMs: event.startAt + autoHideMs - nowMs }
  }
  return { phase: 'idle', event: undefined, remainingMs: 0 }
}

// ---------------------------------------------------------------------------
// Countdown formatting
// ---------------------------------------------------------------------------

export interface Remaining {
  days: number
  hours: number
  minutes: number
  seconds: number
}

/** Break a non-negative duration into DD/HH/MM/SS (negative clamps to zero). */
export function formatRemaining(ms: number): Remaining {
  const totalSec = Math.floor(Math.max(0, ms) / 1000)
  return {
    days: Math.floor(totalSec / 86400),
    hours: Math.floor((totalSec % 86400) / 3600),
    minutes: Math.floor((totalSec % 3600) / 60),
    seconds: totalSec % 60,
  }
}

// ---------------------------------------------------------------------------
// Config resolution (mirrors the plugin.meta configSchema keys)
// ---------------------------------------------------------------------------

const ANIMATIONS = new Set<RevealAnimation>(['fade', 'zoom', 'none'])

/**
 * Accept `#rgb` / `#rrggbb` (with or without the leading `#`), else the brand
 * accent default. Prevents a bad config value from injecting arbitrary CSS.
 */
export function sanitizeColor(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_ACCENT
  const s = raw.trim()
  const hex = s.startsWith('#') ? s.slice(1) : s
  if (/^[0-9a-fA-F]{3}$/.test(hex) || /^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex.toLowerCase()}`
  }
  return DEFAULT_ACCENT
}

/** Clamp `autoHideAfterStartSec` (0..60) to milliseconds; default 5s. */
export function resolveAutoHideMs(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  const sec = Number.isFinite(n) ? Math.min(60, Math.max(0, n)) : DEFAULT_AUTO_HIDE_SEC
  return Math.round(sec * 1000)
}

export interface ScheduledSettings {
  mode: OverlayMode
  accent: string
  headline: string
  revealAnimation: RevealAnimation
  muteUntilStart: boolean
  showViewerLocalTime: boolean
  autoHideMs: number
}

/** Fold a raw persisted config bag into safe, defaulted overlay settings. */
export function resolveSettings(config: ConfigValues): ScheduledSettings {
  const anim =
    typeof config.revealAnimation === 'string' &&
    ANIMATIONS.has(config.revealAnimation as RevealAnimation)
      ? (config.revealAnimation as RevealAnimation)
      : 'fade'
  const headline =
    typeof config.headline === 'string' && config.headline.trim()
      ? config.headline
      : DEFAULT_HEADLINE
  return {
    mode: config.mode === 'badge' ? 'badge' : 'cover',
    accent: sanitizeColor(config.accent),
    headline,
    revealAnimation: anim,
    // Default ON — only an explicit false disables.
    muteUntilStart: config.muteUntilStart !== false,
    showViewerLocalTime: config.showViewerLocalTime !== false,
    autoHideMs: resolveAutoHideMs(config.autoHideAfterStartSec),
  }
}

// ---------------------------------------------------------------------------
// Real-time agenda push (LiveKit data channel — topic `scheduled-live`)
// ---------------------------------------------------------------------------

/**
 * LiveKit data-channel topic of the server-side agenda push. The core sends an
 * `agenda-updated` message on every agenda mutation; the overlay refetches the
 * public agenda immediately on receipt (the 30 s poll stays as fallback for
 * players without a LiveKit connection, e.g. HLS/MJPEG).
 */
export const SCHEDULED_LIVE_TOPIC = 'scheduled-live'

/**
 * True when a raw data-channel payload (bytes or already-decoded string) is a
 * scheduled-live `agenda-updated` push. Defensive: malformed JSON / foreign
 * message shapes are simply ignored (return false), never thrown.
 */
export function isAgendaPush(payload: Uint8Array | string): boolean {
  try {
    const text =
      typeof payload === 'string' ? payload : new TextDecoder().decode(payload)
    const parsed = JSON.parse(text) as { type?: unknown } | null
    return !!parsed && typeof parsed === 'object' && parsed.type === 'agenda-updated'
  } catch {
    return false
  }
}

/** A short, reasonable IANA zone list for the agenda editor's picker. */
export const COMMON_TIMEZONES: string[] = [
  'UTC',
  'America/Argentina/Buenos_Aires',
  'America/Sao_Paulo',
  'America/Santiago',
  'America/Bogota',
  'America/Mexico_City',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/Madrid',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
]
