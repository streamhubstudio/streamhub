/**
 * Pure helpers for the Timestamp CCTV overlay.
 *
 * Framework-agnostic (no React, no DOM) so every branch is unit-tested with
 * Node's built-in runner — the overlay component (index.tsx) is a thin shell
 * around these. Keeping the logic here is the recommended pattern for an
 * overlay plugin: testable formatting/positioning, dumb rendering.
 */
import type { ConfigValues, PluginContext } from '../types.ts'

/** The time-format ids — MUST match the plugin's `configSchema` options. */
export type TimestampFormat =
  | 'datetime-24h'
  | 'datetime-12h'
  | 'time-24h'
  | 'time-12h'
  | 'date-us'

/** The four corners the stamp can be anchored to. */
export type OverlayPosition =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

export const DEFAULT_FORMAT: TimestampFormat = 'datetime-24h'
export const DEFAULT_POSITION: OverlayPosition = 'bottom-right'
export const DEFAULT_COLOR = '#00e5ff'

const FORMATS = new Set<TimestampFormat>([
  'datetime-24h',
  'datetime-12h',
  'time-24h',
  'time-12h',
  'date-us',
])

const POSITIONS = new Set<OverlayPosition>([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
])

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 24h→12h hour with AM/PM marker. Midnight/noon map to 12. */
function to12h(hours: number): { h: number; meridiem: 'AM' | 'PM' } {
  const meridiem = hours < 12 ? 'AM' : 'PM'
  const h = hours % 12 === 0 ? 12 : hours % 12
  return { h, meridiem }
}

/** Narrow an arbitrary config value to a known format id (or the default). */
export function resolveFormat(raw: unknown): TimestampFormat {
  return typeof raw === 'string' && FORMATS.has(raw as TimestampFormat)
    ? (raw as TimestampFormat)
    : DEFAULT_FORMAT
}

/** Narrow an arbitrary config value to a known corner (or the default). */
export function resolvePosition(raw: unknown): OverlayPosition {
  return typeof raw === 'string' && POSITIONS.has(raw as OverlayPosition)
    ? (raw as OverlayPosition)
    : DEFAULT_POSITION
}

/**
 * Accept `#rgb` / `#rrggbb` (case-insensitive, with or without the leading `#`),
 * else fall back to the CCTV cyan default. Prevents a bad config value from
 * injecting arbitrary CSS.
 */
export function sanitizeColor(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_COLOR
  const s = raw.trim()
  const hex = s.startsWith('#') ? s.slice(1) : s
  if (/^[0-9a-fA-F]{3}$/.test(hex) || /^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex.toLowerCase()}`
  }
  return DEFAULT_COLOR
}

/**
 * Format a Date into the CCTV stamp string for a given format id. Uses LOCAL
 * time parts (a viewer sees their wall clock, like a real camera OSD).
 */
export function formatTimestamp(date: Date, format: TimestampFormat): string {
  const y = date.getFullYear()
  const mo = pad2(date.getMonth() + 1)
  const d = pad2(date.getDate())
  const H = date.getHours()
  const m = pad2(date.getMinutes())
  const s = pad2(date.getSeconds())

  switch (format) {
    case 'time-24h':
      return `${pad2(H)}:${m}:${s}`
    case 'time-12h': {
      const { h, meridiem } = to12h(H)
      return `${pad2(h)}:${m}:${s} ${meridiem}`
    }
    case 'datetime-12h': {
      const { h, meridiem } = to12h(H)
      return `${y}-${mo}-${d} ${pad2(h)}:${m}:${s} ${meridiem}`
    }
    case 'date-us':
      return `${mo}/${d}/${y} ${pad2(H)}:${m}:${s}`
    case 'datetime-24h':
    default:
      return `${y}-${mo}-${d} ${pad2(H)}:${m}:${s}`
  }
}

/** Tailwind anchor classes for a corner (used with an absolutely-placed box). */
export function positionClasses(position: OverlayPosition): string {
  switch (position) {
    case 'top-left':
      return 'top-0 left-0'
    case 'top-right':
      return 'top-0 right-0'
    case 'bottom-left':
      return 'bottom-0 left-0'
    case 'bottom-right':
    default:
      return 'bottom-0 right-0'
  }
}

/**
 * The camera / stream label to show alongside the time. Prefers the room name
 * (the "camera"), falling back to the app slug. Returns undefined when neither
 * is known so the caller can render time-only.
 */
export function overlayName(ctx: Pick<PluginContext, 'app' | 'room'>): string | undefined {
  const name = (ctx.room ?? ctx.app ?? '').trim()
  return name.length ? name : undefined
}

/** Whether the camera/stream name should be shown (config `showName`). */
export function shouldShowName(config: ConfigValues): boolean {
  // Default ON — only an explicit `false` hides it.
  return config.showName !== false
}

/** Resolved, render-ready overlay settings from a raw config bag. */
export interface OverlaySettings {
  format: TimestampFormat
  position: OverlayPosition
  color: string
  showName: boolean
}

/** Fold a raw persisted config bag into safe, defaulted overlay settings. */
export function resolveSettings(config: ConfigValues): OverlaySettings {
  return {
    format: resolveFormat(config.format),
    position: resolvePosition(config.position),
    color: sanitizeColor(config.color),
    showName: shouldShowName(config),
  }
}
