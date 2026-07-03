/**
 * Pure helpers for the Watermark player-overlay.
 *
 * Framework-agnostic (no React, no DOM) so every branch is unit-tested with
 * Node's built-in runner — the overlay component (index.tsx) is a thin shell
 * around these. Mirrors the structure of the Timestamp CCTV overlay: testable
 * resolution/positioning, dumb rendering.
 *
 * The resolved settings intentionally mirror the streamhub-core `watermark`
 * plugin's configSchema (text / position / opacity) so an install configured in
 * the dashboard renders identically over the player.
 */
import type { ConfigValues } from '../types.ts'

/** The four corners the watermark can be anchored to. */
export type OverlayPosition =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

export const DEFAULT_TEXT = 'StreamHub'
export const DEFAULT_POSITION: OverlayPosition = 'bottom-right'
export const DEFAULT_OPACITY = 0.6

/** Hard cap so a hostile / runaway config value can't blow up the overlay. */
export const MAX_TEXT_LEN = 120

const POSITIONS = new Set<OverlayPosition>([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
])

/**
 * Narrow an arbitrary config value to the watermark text: a trimmed, length-
 * capped string, falling back to the brand default when empty or non-string.
 */
export function resolveText(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_TEXT
  const s = raw.trim()
  if (!s.length) return DEFAULT_TEXT
  return s.length > MAX_TEXT_LEN ? s.slice(0, MAX_TEXT_LEN) : s
}

/** Narrow an arbitrary config value to a known corner (or the default). */
export function resolvePosition(raw: unknown): OverlayPosition {
  return typeof raw === 'string' && POSITIONS.has(raw as OverlayPosition)
    ? (raw as OverlayPosition)
    : DEFAULT_POSITION
}

/**
 * Coerce a config value to an opacity in [0, 1]. Accepts numbers or numeric
 * strings; anything non-finite falls back to the default. Out-of-range values
 * are clamped rather than rejected.
 */
export function clampOpacity(raw: unknown): number {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN
  if (!Number.isFinite(n)) return DEFAULT_OPACITY
  if (n < 0) return 0
  if (n > 1) return 1
  return n
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

/** Resolved, render-ready overlay settings from a raw config bag. */
export interface OverlaySettings {
  text: string
  position: OverlayPosition
  opacity: number
}

/** Fold a raw persisted config bag into safe, defaulted overlay settings. */
export function resolveSettings(config: ConfigValues): OverlaySettings {
  return {
    text: resolveText(config.text),
    position: resolvePosition(config.position),
    opacity: clampOpacity(config.opacity),
  }
}
